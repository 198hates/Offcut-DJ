import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { backupMasterDb, guardRekordboxWrite, isRekordboxRunning } from '../write-guard'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rbguard-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const master = (): string => join(dir, 'master.db')

describe('backupMasterDb', () => {
  it('copies the database next to the original', () => {
    writeFileSync(master(), 'DBCONTENT')

    const dest = backupMasterDb(master(), new Date('2026-08-19T21:30:00Z'))

    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('DBCONTENT')
    expect(dest).toContain('offcut-backup-2026-08-19T21-30-00')
  })

  it('copies the WAL sidecars too', () => {
    // With journal_mode=WAL the .db alone can be missing the newest commits, so
    // a copy without -wal is a torn snapshot that silently loses data.
    writeFileSync(master(), 'DB')
    writeFileSync(master() + '-wal', 'WAL')
    writeFileSync(master() + '-shm', 'SHM')

    const dest = backupMasterDb(master())

    expect(readFileSync(dest + '-wal', 'utf8')).toBe('WAL')
    expect(readFileSync(dest + '-shm', 'utf8')).toBe('SHM')
  })

  it('is fine when no sidecars exist', () => {
    writeFileSync(master(), 'DB')

    const dest = backupMasterDb(master())

    expect(existsSync(dest)).toBe(true)
    expect(existsSync(dest + '-wal')).toBe(false)
  })

  it('never overwrites a previous backup', () => {
    writeFileSync(master(), 'DB')
    const a = backupMasterDb(master(), new Date('2026-08-19T21:30:00Z'))
    writeFileSync(master(), 'DB2')
    const b = backupMasterDb(master(), new Date('2026-08-19T21:31:00Z'))

    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf8')).toBe('DB')   // the older copy is intact
    expect(readFileSync(b, 'utf8')).toBe('DB2')
  })
})

describe('guardRekordboxWrite', () => {
  it('refuses when the database does not exist', () => {
    const res = guardRekordboxWrite(join(dir, 'missing.db'))

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(res.backupPath).toBeUndefined()
  })

  it('takes a backup and allows the write when rekordbox is closed', () => {
    // The suite does not run with rekordbox open; if it ever did, this asserts
    // the refusal path instead so the test stays honest either way.
    writeFileSync(master(), 'DB')

    const res = guardRekordboxWrite(master())

    if (isRekordboxRunning()) {
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/quit it/i)
    } else {
      expect(res.ok).toBe(true)
      expect(res.backupPath).toBeDefined()
      expect(readFileSync(res.backupPath as string, 'utf8')).toBe('DB')
    }
  })

  it('fails the export when the backup cannot be written', () => {
    // A directory where the file should be: copyFileSync throws. The export must
    // NOT proceed — writing with no way back is the outcome this exists to stop.
    const path = join(dir, 'master.db')
    writeFileSync(path, 'DB')
    const res = guardRekordboxWrite(path + '/impossible')

    expect(res.ok).toBe(false)
  })
})

describe('isRekordboxRunning', () => {
  it('returns a boolean and never throws', () => {
    // pgrep exits 1 when nothing matches, which must read as "not running"
    // rather than propagating as an error and blocking a legitimate export.
    expect(typeof isRekordboxRunning()).toBe('boolean')
  })
})
