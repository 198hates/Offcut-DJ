/**
 * Library backups — versioned, restorable snapshots of the SQLite library.
 *
 * The #1 fear DJs voice is a corrupted library / lost cues. We take online
 * snapshots (better-sqlite3's safe `.backup()` — no need to close the live DB)
 * into userData/backups, keep the most recent N, and can restore one over the
 * live DB (which then relaunches the app). An automatic snapshot is taken before
 * risky operations (imports) so they're always reversible. Local-first; no cloud.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs'
import { getLibraryDb, closeLibraryDb, libraryDbPath } from '../library/db'

const MAX_BACKUPS = 20
const PREFIX = 'library-'
const EXT = '.db'

export interface BackupInfo {
  name: string
  label: string | null
  sizeBytes: number
  createdAt: string // ISO
}

function backupsDir(): string {
  const dir = join(app.getPath('userData'), 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Filenames look like `library-2026-06-16T07-41-09-123Z[__label].db`. */
function parseName(name: string): BackupInfo | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(EXT)) return null
  const stem = name.slice(PREFIX.length, -EXT.length)
  const [ts, ...labelParts] = stem.split('__')
  const iso = ts.replace(/-(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  let sizeBytes = 0
  try { sizeBytes = statSync(join(backupsDir(), name)).size } catch { /* ignore */ }
  return {
    name,
    label: labelParts.length ? labelParts.join('__') : null,
    sizeBytes,
    createdAt: isNaN(Date.parse(iso)) ? new Date(0).toISOString() : iso
  }
}

export function listBackups(): BackupInfo[] {
  try {
    return readdirSync(backupsDir())
      .map(parseName)
      .filter((b): b is BackupInfo => b !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

function pruneOld(): void {
  const all = listBackups()
  for (const b of all.slice(MAX_BACKUPS)) {
    try { rmSync(join(backupsDir(), b.name), { force: true }) } catch { /* ignore */ }
  }
}

/**
 * Take an online snapshot of the live DB. `label` is sanitised into the
 * filename. Returns the created BackupInfo. Safe to call while the app runs.
 */
export async function createBackup(label?: string): Promise<BackupInfo> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') // 2026-06-16T07-41-09-123Z
  const safe = (label ?? '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const name = `${PREFIX}${stamp}${safe ? '__' + safe : ''}${EXT}`
  await getLibraryDb().backup(join(backupsDir(), name))
  pruneOld()
  return parseName(name)!
}

/** Best-effort auto snapshot before a risky op; never throws into the caller. */
export async function autoBackup(label: string): Promise<void> {
  try { await createBackup(label) } catch (err) { console.error('autoBackup failed:', err) }
}

/**
 * Restore a snapshot OVER the live DB, then relaunch the app. Takes a safety
 * snapshot of the current state first so a restore is itself reversible.
 */
export async function restoreBackup(name: string): Promise<void> {
  const src = join(backupsDir(), name)
  if (!parseName(name) || !existsSync(src)) throw new Error('Backup not found')
  await autoBackup('pre-restore')
  closeLibraryDb()
  const dbPath = libraryDbPath()
  // Remove WAL/SHM sidecars so the restored file isn't shadowed by stale journal.
  for (const ext of ['-wal', '-shm']) { try { rmSync(dbPath + ext, { force: true }) } catch { /* ignore */ } }
  copyFileSync(src, dbPath)
  app.relaunch()
  app.exit(0)
}

export function deleteBackup(name: string): void {
  if (!parseName(name)) return
  try { rmSync(join(backupsDir(), name), { force: true }) } catch { /* ignore */ }
}
