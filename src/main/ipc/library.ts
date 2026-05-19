import { ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { getLibraryDb, rowToTrack, rowToPlaylist } from '../library/db'
import { resolveSmartPlaylist } from '../library/smart-playlist'
import { importFromIntegration as importRekordbox } from '../integrations/rekordbox/reader'
import { exportToIntegration as exportRekordbox } from '../integrations/rekordbox/writer'
import {
  importFromRekordboxDb,
  exportToRekordboxDb,
  isRekordboxDbAvailable,
  getDefaultRekordboxDbPath
} from '../integrations/rekordbox/db-reader'
import { importFromIntegration as importTraktor } from '../integrations/traktor/reader'
import { exportToIntegration as exportTraktor } from '../integrations/traktor/writer'
import { importFromIntegration as importAppleMusic } from '../integrations/apple-music/reader'
import { importFromIntegration as importSerato } from '../integrations/serato/reader'
import { exportToIntegration as exportSerato } from '../integrations/serato/writer'
import {
  importFromIntegration as importEngineDj,
  exportToIntegration as exportEngineDj,
  getDefaultEngineDbPath
} from '../integrations/engine-dj/reader'
import { exportToIntegration as exportM3u } from '../integrations/m3u/writer'
import type { Track, Playlist, LibraryStats, ImportResult, ExportResult, IntegrationId, SmartRule } from '../../shared/types'
import type Database from 'better-sqlite3'

type IntegrationReader = (db: Database.Database, path: string) => ImportResult
type IntegrationWriter = (db: Database.Database, path: string) => ExportResult

const READERS: Partial<Record<IntegrationId, IntegrationReader>> = {
  rekordbox: importRekordbox,
  traktor: importTraktor,
  'apple-music': importAppleMusic,
  serato: importSerato,
  'engine-dj': importEngineDj
}

const WRITERS: Partial<Record<IntegrationId, IntegrationWriter>> = {
  rekordbox: exportRekordbox,
  traktor: exportTraktor,
  serato: exportSerato,
  'engine-dj': exportEngineDj,
  m3u: exportM3u
}

const COL_MAP: Record<string, string> = {
  filePath: 'file_path',
  durationSeconds: 'duration_seconds',
  dateAdded: 'date_added',
  sourceIds: 'source_ids',
  cuePoints: 'cue_points'
}

export function registerLibraryHandlers(): void {
  const db = getLibraryDb()

  // ── Read ──────────────────────────────────────────────────────────────────
  ipcMain.handle('library:getTracks', (): Track[] =>
    (db.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]).map(rowToTrack)
  )

  ipcMain.handle('library:getPlaylists', (): Playlist[] => {
    const rows = db.prepare('SELECT * FROM playlists ORDER BY sort_order, name').all() as Record<string, unknown>[]
    return rows.map((pl) => {
      if (pl.is_smart) {
        const rules: SmartRule[] = JSON.parse((pl.rules as string) || '[]')
        const trackIds = resolveSmartPlaylist(db, rules)
        return rowToPlaylist(pl, trackIds)
      }
      const trackRows = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order').all(pl.id as string) as { track_id: string }[]
      return rowToPlaylist(pl, trackRows.map((r) => r.track_id))
    })
  })

  ipcMain.handle('library:getStats', (): LibraryStats => ({
    trackCount: (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c,
    playlistCount: (db.prepare('SELECT COUNT(*) as c FROM playlists').get() as { c: number }).c
  }))

  // ── Write: single track ───────────────────────────────────────────────────
  ipcMain.handle('library:updateTrack', (_e, patch: Partial<Track> & { id: string }): Track => {
    const { id, ...fields } = patch
    if (Object.keys(fields).length > 0) {
      const setClauses = Object.keys(fields).map((k) => `${COL_MAP[k] ?? k} = @${k}`).join(', ')
      const params = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]))
      db.prepare(`UPDATE tracks SET ${setClauses}, updated_at = datetime('now') WHERE id = @id`).run({ ...params, id })
    }
    return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
  })

  // ── Write: bulk update ────────────────────────────────────────────────────
  ipcMain.handle('library:bulkUpdateTracks', (_e, ids: string[], patch: Partial<Track>): Track[] => {
    if (!ids.length || !Object.keys(patch).length) return []
    const setClauses = Object.keys(patch).map((k) => `${COL_MAP[k] ?? k} = @${k}`).join(', ')
    const params = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]))
    const stmt = db.prepare(`UPDATE tracks SET ${setClauses}, updated_at = datetime('now') WHERE id = @id`)
    const bulkUpdate = db.transaction(() => {
      for (const id of ids) stmt.run({ ...params, id })
    })
    bulkUpdate()
    const placeholders = ids.map(() => '?').join(',')
    return (db.prepare(`SELECT * FROM tracks WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[]).map(rowToTrack)
  })

  // ── Delete ────────────────────────────────────────────────────────────────
  ipcMain.handle('library:deleteTrack', (_e, id: string): void => {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(id)
  })

  ipcMain.handle('library:deleteTracks', (_e, ids: string[]): void => {
    if (!ids.length) return
    const ph = ids.map(() => '?').join(',')
    db.prepare(`DELETE FROM tracks WHERE id IN (${ph})`).run(...ids)
  })

  // ── Playlists ─────────────────────────────────────────────────────────────
  ipcMain.handle('library:createPlaylist', (_e, name: string): Playlist => {
    const id = randomUUID()
    db.prepare('INSERT INTO playlists (id, name, is_folder, sort_order, source_ids) VALUES (?, ?, 0, 0, \'{}\')').run(id, name)
    const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, unknown>
    return rowToPlaylist(row, [])
  })

  ipcMain.handle('library:createSmartPlaylist', (_e, name: string, rules: SmartRule[]): Playlist => {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO playlists (id, name, is_folder, is_smart, rules, sort_order, source_ids) VALUES (?, ?, 0, 1, ?, 0, '{}')"
    ).run(id, name, JSON.stringify(rules))
    const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, unknown>
    const trackIds = resolveSmartPlaylist(db, rules)
    return rowToPlaylist(row, trackIds)
  })

  ipcMain.handle('library:updateSmartPlaylistRules', (_e, id: string, name: string, rules: SmartRule[]): void => {
    db.prepare("UPDATE playlists SET name = ?, rules = ?, updated_at = datetime('now') WHERE id = ?").run(name, JSON.stringify(rules), id)
  })

  ipcMain.handle('library:renamePlaylist', (_e, id: string, name: string): void => {
    db.prepare("UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
  })

  ipcMain.handle('library:deletePlaylist', (_e, id: string): void => {
    db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  })

  ipcMain.handle('library:addTracksToPlaylist', (_e, playlistId: string, trackIds: string[]): void => {
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId) as { m: number }).m
    const stmt = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
    const insert = db.transaction(() => {
      trackIds.forEach((tid, i) => stmt.run(playlistId, tid, maxOrder + 1 + i))
    })
    insert()
  })

  // ── Import ────────────────────────────────────────────────────────────────
  ipcMain.handle('library:importFromPath', async (_e, integrationId: IntegrationId, filePath?: string): Promise<ImportResult> => {
    const reader = READERS[integrationId]
    if (!reader) return { tracksImported: 0, playlistsImported: 0, errors: [`Import from ${integrationId} not supported`] }

    let resolvedPath = filePath
    if (!resolvedPath) {
      const isDirectory = integrationId === 'serato'
      const res = await dialog.showOpenDialog({
        properties: isDirectory ? ['openDirectory'] : ['openFile'],
        filters: isDirectory ? [] : getImportFilters(integrationId)
      })
      if (res.canceled) return { tracksImported: 0, playlistsImported: 0, errors: ['Import cancelled'] }
      resolvedPath = res.filePaths[0]
    }
    return reader(db, resolvedPath)
  })

  // ── Export ────────────────────────────────────────────────────────────────
  ipcMain.handle('library:exportToPath', async (_e, integrationId: IntegrationId, filePath?: string): Promise<ExportResult> => {
    const writer = WRITERS[integrationId]
    if (!writer) return { tracksExported: 0, playlistsExported: 0, errors: [`Export to ${integrationId} not yet supported`], cancelled: false }

    let resolvedPath = filePath
    if (!resolvedPath) {
      if (integrationId === 'serato' || integrationId === 'm3u') {
        const title = integrationId === 'm3u' ? 'Choose export folder for M3U playlists' : 'Choose your _Serato_ folder'
        const res = await dialog.showOpenDialog({ title, properties: ['openDirectory'] })
        if (res.canceled) return { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: true }
        resolvedPath = res.filePaths[0]
      } else if (integrationId === 'engine-dj') {
        const defaultPath = getDefaultEngineDbPath()
        const res = await dialog.showOpenDialog({
          title: 'Select Engine DJ database (m.db)',
          defaultPath: existsSync(defaultPath) ? defaultPath : undefined,
          filters: [{ name: 'Engine DJ Database', extensions: ['db'] }]
        })
        if (res.canceled) return { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: true }
        resolvedPath = res.filePaths[0]
      } else {
        const res = await dialog.showSaveDialog({
          filters: getExportFilters(integrationId),
          defaultPath: `library-${integrationId}-${new Date().toISOString().slice(0, 10)}`
        })
        if (res.canceled || !res.filePath) return { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: true }
        resolvedPath = res.filePath
      }
    }
    return writer(db, resolvedPath)
  })

  // ── Library Health ────────────────────────────────────────────────────────
  ipcMain.handle('library:scanMissingFiles', (): Track[] => {
    const rows = db.prepare('SELECT * FROM tracks').all() as Record<string, unknown>[]
    return rows
      .filter((r) => !existsSync(r.file_path as string))
      .map(rowToTrack)
  })

  // ── Rekordbox direct DB sync ──────────────────────────────────────────────
  ipcMain.handle('library:rekordboxDbStatus', () => ({
    available: isRekordboxDbAvailable(),
    path: getDefaultRekordboxDbPath()
  }))

  ipcMain.handle(
    'library:importFromRekordboxDb',
    async (_e, dbPath?: string): Promise<ImportResult> => {
      let resolvedPath = dbPath ?? getDefaultRekordboxDbPath()
      if (!existsSync(resolvedPath)) {
        const res = await dialog.showOpenDialog({
          title: 'Select Rekordbox master.db',
          filters: [{ name: 'SQLite Database', extensions: ['db'] }]
        })
        if (res.canceled) return { tracksImported: 0, playlistsImported: 0, errors: ['Cancelled'] }
        resolvedPath = res.filePaths[0]
      }
      return importFromRekordboxDb(db, resolvedPath)
    }
  )

  ipcMain.handle(
    'library:exportToRekordboxDb',
    async (_e, dbPath?: string): Promise<ExportResult> => {
      let resolvedPath = dbPath ?? getDefaultRekordboxDbPath()
      if (!existsSync(resolvedPath)) {
        const res = await dialog.showOpenDialog({
          title: 'Select Rekordbox master.db',
          filters: [{ name: 'SQLite Database', extensions: ['db'] }]
        })
        if (res.canceled) return { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: true }
        resolvedPath = res.filePaths[0]
      }
      return exportToRekordboxDb(db, resolvedPath)
    }
  )
}

function getImportFilters(id: IntegrationId): Electron.FileFilter[] {
  const map: Partial<Record<IntegrationId, Electron.FileFilter>> = {
    rekordbox: { name: 'Rekordbox XML', extensions: ['xml'] },
    traktor: { name: 'Traktor Collection', extensions: ['nml'] },
    'apple-music': { name: 'iTunes Library XML', extensions: ['xml'] },
    serato: { name: 'All Files', extensions: ['*'] },
    'engine-dj': { name: 'Engine DJ Database', extensions: ['db'] }
  }
  return [map[id] ?? { name: 'All Files', extensions: ['*'] }]
}

function getExportFilters(id: IntegrationId): Electron.FileFilter[] {
  const map: Partial<Record<IntegrationId, Electron.FileFilter>> = {
    rekordbox: { name: 'Rekordbox XML', extensions: ['xml'] },
    traktor: { name: 'Traktor Collection (NML)', extensions: ['nml'] }
  }
  return [map[id] ?? { name: 'All Files', extensions: ['*'] }]
}
