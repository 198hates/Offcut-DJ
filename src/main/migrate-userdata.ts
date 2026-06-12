import { app } from 'electron'
import { existsSync, copyFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'

// Files worth carrying across the rename (skip Chromium caches, GPUCache, etc.).
const MIGRATE_FILES = ['library.db', 'library.db-wal', 'library.db-shm', 'settings.json']

/**
 * One-time data-folder migration after the Crate → Offcut rebrand.
 *
 * Electron derives `userData` from the app name, so renaming the product moves
 * the folder (…/Application Support/Crate → Offcut). If the new folder has no
 * library yet but an old Crate/crate folder does, copy the user's library and
 * settings across so nothing is lost. Non-destructive: never overwrites a file
 * that already exists in the new folder, and silent/non-fatal on any error.
 */
export function migrateUserDataFromCrate(): void {
  try {
    const newDir = app.getPath('userData')
    if (existsSync(join(newDir, 'library.db'))) return // already populated — nothing to do

    const parent = app.getPath('appData')
    const newName = basename(newDir)
    // Old packaged name was "Crate"; old dev name was lowercase "crate".
    const candidates = ['Offcut', 'Crate', 'offcut', 'crate'].filter((n) => n !== newName)

    for (const oldName of candidates) {
      const oldDir = join(parent, oldName)
      if (!existsSync(join(oldDir, 'library.db'))) continue

      mkdirSync(newDir, { recursive: true })
      let copied = 0
      for (const f of MIGRATE_FILES) {
        const src = join(oldDir, f)
        const dest = join(newDir, f)
        if (existsSync(src) && !existsSync(dest)) {
          copyFileSync(src, dest)
          copied++
        }
      }
      console.info(`[migrate] carried ${copied} file(s) from "${oldName}" → "${newName}"`)
      return
    }
  } catch (err) {
    console.error('[migrate] userData migration failed (non-fatal):', err)
  }
}
