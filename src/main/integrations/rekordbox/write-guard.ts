/**
 * Safety rails for the one code path that WRITES to rekordbox's master.db.
 *
 * Everything else Offcut does with rekordbox is read-only. The export is not:
 * it rewrites Title/BPM/Rating/Commnt/FolderPath and deletes-and-reinserts
 * djmdCue rows. That is someone's entire library, in an application that keeps
 * the file open and holds state in memory.
 *
 * Two rules, both learned the hard way in principle if not in practice:
 *
 *  1. Never write while rekordbox is running. It caches rows, writes on its own
 *     schedule, and will happily overwrite or be overwritten — a torn write to
 *     an encrypted SQLite file is not something a user can repair.
 *  2. Never write without a copy first. The export is not reversible, and
 *     "restore from the backup" is the only honest recovery story.
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync } from 'fs'

/** WAL sidecars — a copy without these can be a torn snapshot. */
const SIDECARS = ['-wal', '-shm'] as const

/**
 * Is the rekordbox desktop app running right now?
 *
 * Conservative by design: if we cannot tell (unknown platform, pgrep missing),
 * report false rather than blocking a legitimate export — the backup below is
 * still taken either way.
 */
export function isRekordboxRunning(): boolean {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // -x: exact name match, so "rekordboxAgent" and helpers don't count.
      const out = execFileSync('pgrep', ['-x', 'rekordbox'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return out.trim().length > 0
    }
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq rekordbox.exe'], { encoding: 'utf8' })
      return /rekordbox\.exe/i.test(out)
    }
  } catch {
    // pgrep exits 1 when nothing matches — that is "not running", not an error.
  }
  return false
}

/**
 * Copy master.db (and its WAL sidecars) alongside the original, returning the
 * backup path. Sidecars matter: with journal_mode=WAL the .db alone can be
 * missing the most recent commits.
 *
 * Backups are deliberately NOT pruned. They are ~90MB each and they are the
 * user's only undo for an irreversible write, so deciding on their behalf when
 * a safety copy has outlived its usefulness is not our call — the path is
 * reported so they can clear old ones.
 */
export function backupMasterDb(masterDbPath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const dest = `${masterDbPath}.offcut-backup-${stamp}`
  copyFileSync(masterDbPath, dest)
  for (const s of SIDECARS) {
    if (existsSync(masterDbPath + s)) copyFileSync(masterDbPath + s, dest + s)
  }
  return dest
}

export interface GuardResult {
  ok: boolean
  /** Where the pre-write copy landed, when one was taken. */
  backupPath?: string
  error?: string
}

/** Run both checks. Call immediately before opening master.db for writing. */
export function guardRekordboxWrite(masterDbPath: string): GuardResult {
  if (!existsSync(masterDbPath)) {
    return { ok: false, error: `Rekordbox database not found at ${masterDbPath}` }
  }
  if (isRekordboxRunning()) {
    return {
      ok: false,
      error:
        'Rekordbox is running. Quit it before exporting — writing to its database ' +
        'while it is open risks corrupting your library.'
    }
  }
  try {
    return { ok: true, backupPath: backupMasterDb(masterDbPath) }
  } catch (err) {
    // A failed backup fails the export. Writing anyway would leave no way back.
    return { ok: false, error: `Could not back up the Rekordbox database: ${(err as Error).message}` }
  }
}
