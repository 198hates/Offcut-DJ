import { ipcMain, dialog } from 'electron'
import { existsSync, writeFileSync } from 'fs'
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
import { exportToIntegration as exportVirtualDj } from '../integrations/virtualdj/writer'
import { analyzeBeats, isModelAvailable, getDefaultModelPath, warmModel } from '../integrations/beat-analysis'
import { writeTagsToFile } from '../integrations/file-tags/writer'
import { startWatcher } from '../integrations/watch-folder'
import { loadSettings, saveSettings } from '../settings'
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
  m3u: exportM3u,
  virtualdj: exportVirtualDj
}

const COL_MAP: Record<string, string> = {
  filePath: 'file_path',
  durationSeconds: 'duration_seconds',
  dateAdded: 'date_added',
  sourceIds: 'source_ids',
  cuePoints: 'cue_points',
  customTags: 'custom_tags',
  analysedBeatgrid: 'analysed_beatgrid',
  editLineage: 'edit_lineage'
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

  ipcMain.handle('library:updatePlaylistColor', (_e, id: string, color: string): void => {
    db.prepare("UPDATE playlists SET color = ?, updated_at = datetime('now') WHERE id = ?").run(color, id)
  })

  ipcMain.handle(
    'library:recordPlay',
    (_e, id: string, opts?: { mixedFrom?: string; deckId?: 'A' | 'B' }): Track => {
      db.prepare(
        "UPDATE tracks SET play_count = play_count + 1, last_played_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(id)
      const { v4: uuid } = require('uuid')
      db.prepare(
        "INSERT INTO play_history (id, track_id, played_at, mixed_from, deck_id) VALUES (?, ?, datetime('now'), ?, ?)"
      ).run(uuid(), id, opts?.mixedFrom ?? null, opts?.deckId ?? null)
      return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
    }
  )

  /** Full cut history for one track: play events + edit lineage */
  ipcMain.handle('library:getCutHistory', (_e, trackId: string) => {
    const track = db.prepare('SELECT play_count, last_played_at, edit_lineage FROM tracks WHERE id = ?').get(trackId) as Record<string, unknown> | undefined
    if (!track) return null

    const rows = db.prepare(
      "SELECT id, played_at, mixed_from, mixed_into, deck_id FROM play_history WHERE track_id = ? ORDER BY played_at DESC LIMIT 50"
    ).all(trackId) as { id: string; played_at: string; mixed_from: string | null; mixed_into: string | null; deck_id: string | null }[]

    const firstRow = db.prepare(
      "SELECT played_at FROM play_history WHERE track_id = ? ORDER BY played_at ASC LIMIT 1"
    ).get(trackId) as { played_at: string } | undefined

    return {
      trackId,
      plays: rows.map((r) => ({
        id: r.id,
        at: r.played_at,
        mixedFrom: r.mixed_from ?? null,
        mixedInto: r.mixed_into ?? null,
        deckId: (r.deck_id as 'A' | 'B' | null) ?? null,
      })),
      editLineage: track.edit_lineage ? JSON.parse(track.edit_lineage as string) : { isEdit: false, originalId: null, versionLabel: null },
      playCount: (track.play_count as number) ?? 0,
      firstPlayedAt: firstRow?.played_at ?? null,
      lastPlayedAt: (track.last_played_at as string | null) ?? null,
    }
  })

  /** Update edit lineage for a track */
  ipcMain.handle('library:updateEditLineage', (_e, trackId: string, lineage: import('../../shared/types').EditLineage): void => {
    db.prepare("UPDATE tracks SET edit_lineage = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(lineage), trackId)
  })

  /** Returns play counts per calendar day for the last N weeks (default 52) */
  ipcMain.handle('library:getPlayHistory', (_e, weeks = 52): { day: string; count: number }[] => {
    const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return db.prepare(
      "SELECT date(played_at) as day, COUNT(*) as count FROM play_history WHERE date(played_at) >= ? GROUP BY day ORDER BY day"
    ).all(since) as { day: string; count: number }[]
  })

  ipcMain.handle('library:deletePlaylist', (_e, id: string): void => {
    db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  })

  // ── Set Builder ───────────────────────────────────────────────────────────
  // A "set" is a folder-type playlist; chapters are its non-folder children.

  ipcMain.handle('library:createSet', (_e, name: string): Playlist => {
    const id = randomUUID()
    const maxSort = ((db.prepare("SELECT COALESCE(MAX(sort_order),-1) as m FROM playlists WHERE parent_id IS NULL").get()) as { m: number }).m
    db.prepare("INSERT INTO playlists (id, name, is_folder, sort_order, source_ids) VALUES (?, ?, 1, ?, '{}')").run(id, name, maxSort + 1)
    return rowToPlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, unknown>, [])
  })

  ipcMain.handle('library:createChapter', (_e, setId: string, name: string, color: string): Playlist => {
    const id = randomUUID()
    const maxSort = ((db.prepare("SELECT COALESCE(MAX(sort_order),-1) as m FROM playlists WHERE parent_id = ?").get(setId)) as { m: number }).m
    db.prepare("INSERT INTO playlists (id, name, parent_id, color, sort_order, source_ids) VALUES (?, ?, ?, ?, ?, '{}')").run(id, name, setId, color, maxSort + 1)
    return rowToPlaylist(db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, unknown>, [])
  })

  ipcMain.handle('library:reorderChapters', (_e, setId: string, orderedIds: string[]): void => {
    const stmt = db.prepare("UPDATE playlists SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND parent_id = ?")
    const update = db.transaction(() => { orderedIds.forEach((cid, i) => stmt.run(i, cid, setId)) })
    update()
  })

  // ── Auto Group ────────────────────────────────────────────────────────────
  // Replaces all auto-group playlists with the provided clusters.
  // Each cluster becomes a named playlist inside an "Auto Groups" folder.
  ipcMain.handle(
    'library:runAutoGroup',
    (_e, clusters: { name: string; trackIds: string[] }[]): void => {
      db.transaction(() => {
        // Remove all existing auto-group playlists + their track rows (cascade)
        db.prepare('DELETE FROM playlists WHERE is_auto_group = 1').run()

        if (!clusters.length) return

        // Create / re-create the folder
        const folderId = randomUUID()
        db.prepare(
          "INSERT INTO playlists (id, name, is_folder, is_auto_group, sort_order, source_ids) VALUES (?, 'Auto Groups', 1, 1, 9999, '{}')"
        ).run(folderId)

        const insertPl  = db.prepare(
          'INSERT INTO playlists (id, name, is_auto_group, parent_id, sort_order, source_ids) VALUES (?, ?, 1, ?, ?, \'{}\')'
        )
        const insertTrk = db.prepare(
          'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
        )

        clusters.forEach(({ name, trackIds }, i) => {
          const plId = randomUUID()
          insertPl.run(plId, name, folderId, i)
          trackIds.forEach((tid, j) => insertTrk.run(plId, tid, j))
        })
      })()
    }
  )

  // Replace one track with another across all playlists before deletion.
  // For each playlist containing removeId:
  //   - if keepId is not already there: update the row (preserving sort_order)
  //   - if keepId is already there: just delete the removeId row
  // Returns the number of playlists that were modified.
  ipcMain.handle('library:replaceTrackInPlaylists', (_e, removeId: string, keepId: string): number => {
    const rows = db.prepare(
      'SELECT playlist_id FROM playlist_tracks WHERE track_id = ?'
    ).all(removeId) as { playlist_id: string }[]

    if (!rows.length) return 0

    let count = 0
    const op = db.transaction(() => {
      for (const { playlist_id } of rows) {
        const keepExists = db.prepare(
          'SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?'
        ).get(playlist_id, keepId)

        if (!keepExists) {
          db.prepare(
            'UPDATE playlist_tracks SET track_id = ? WHERE playlist_id = ? AND track_id = ?'
          ).run(keepId, playlist_id, removeId)
          count++
        } else {
          db.prepare(
            'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?'
          ).run(playlist_id, removeId)
        }
      }
    })
    op()
    return count
  })

  ipcMain.handle('library:removeTracksFromPlaylist', (_e, playlistId: string, trackIds: string[]): void => {
    if (!trackIds.length) return
    const ph = trackIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id IN (${ph})`).run(playlistId, ...trackIds)
  })

  ipcMain.handle('library:reorderPlaylistTracks', (_e, playlistId: string, orderedIds: string[]): void => {
    const stmt = db.prepare('UPDATE playlist_tracks SET sort_order = ? WHERE playlist_id = ? AND track_id = ?')
    const update = db.transaction(() => {
      orderedIds.forEach((tid, i) => stmt.run(i, playlistId, tid))
    })
    update()
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

  // ── Playlist file export ──────────────────────────────────────────────────
  ipcMain.handle('library:exportPlaylistM3U', async (_e, playlistId: string): Promise<void> => {
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as Record<string, unknown> | undefined
    if (!pl) return
    const trackIds: string[] = pl.is_smart
      ? resolveSmartPlaylist(db, JSON.parse((pl.rules as string) || '[]'))
      : (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order').all(playlistId) as { track_id: string }[]).map((r) => r.track_id)
    const tracks = trackIds.length
      ? (db.prepare(`SELECT * FROM tracks WHERE id IN (${trackIds.map(() => '?').join(',')})`).all(...trackIds) as Record<string, unknown>[]).map(rowToTrack)
      : []
    const res = await dialog.showSaveDialog({
      title: 'Export playlist as M3U',
      defaultPath: `${pl.name as string}.m3u`,
      filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }]
    })
    if (res.canceled || !res.filePath) return
    const lines = ['#EXTM3U']
    for (const t of tracks) {
      lines.push(`#EXTINF:${t.durationSeconds != null ? Math.round(t.durationSeconds) : -1},${t.artist} - ${t.title}`)
      lines.push(t.filePath)
    }
    writeFileSync(res.filePath, lines.join('\n'), 'utf8')
  })

  ipcMain.handle('library:exportPlaylistCSV', async (_e, playlistId: string): Promise<void> => {
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId) as Record<string, unknown> | undefined
    if (!pl) return
    const trackIds: string[] = pl.is_smart
      ? resolveSmartPlaylist(db, JSON.parse((pl.rules as string) || '[]'))
      : (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order').all(playlistId) as { track_id: string }[]).map((r) => r.track_id)
    const tracks = trackIds.length
      ? (db.prepare(`SELECT * FROM tracks WHERE id IN (${trackIds.map(() => '?').join(',')})`).all(...trackIds) as Record<string, unknown>[]).map(rowToTrack)
      : []
    const res = await dialog.showSaveDialog({
      title: 'Export playlist as CSV',
      defaultPath: `${pl.name as string}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return
    const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
    const header = ['Title', 'Artist', 'Album', 'Genre', 'BPM', 'Key', 'Duration (s)', 'Rating', 'Energy', 'Comment', 'File Path']
    const rows = tracks.map((t) => [
      q(t.title), q(t.artist), q(t.album), q(t.genre),
      t.bpm != null ? t.bpm.toFixed(2) : '', t.key || '',
      t.durationSeconds != null ? String(Math.round(t.durationSeconds)) : '',
      String(t.rating), t.energy != null ? String(t.energy) : '',
      q(t.comment), q(t.filePath)
    ].join(','))
    writeFileSync(res.filePath, [header.map(q).join(','), ...rows].join('\n'), 'utf8')
  })

  // ── Write tags to audio file ──────────────────────────────────────────────
  ipcMain.handle('library:writeTagsToFile', async (_e, trackId: string) => {
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as Record<string, unknown> | undefined
    if (!row) return { success: false, error: 'Track not found' }
    return writeTagsToFile(rowToTrack(row))
  })

  ipcMain.handle('library:writeTagsBulk', async (_e, trackIds: string[]) => {
    let succeeded = 0, failed = 0, skipped = 0
    for (const id of trackIds) {
      const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!row) { failed++; continue }
      const result = await writeTagsToFile(rowToTrack(row))
      if (result.skipped) skipped++
      else if (result.success) succeeded++
      else failed++
    }
    return { succeeded, failed, skipped }
  })

  // ── Path mapping ─────────────────────────────────────────────────────────
  ipcMain.handle('library:previewPathMapping', (_e, from: string, to: string): number => {
    if (!from || !to) return 0
    return ((db.prepare('SELECT COUNT(*) as c FROM tracks WHERE file_path LIKE ?').get(from + '%')) as { c: number }).c
  })

  ipcMain.handle('library:applyPathMapping', (_e, from: string, to: string): number => {
    if (!from || !to) return 0
    const result = db.prepare(
      "UPDATE tracks SET file_path = REPLACE(file_path, ?, ?), updated_at = datetime('now') WHERE file_path LIKE ?"
    ).run(from, to, from + '%')
    return result.changes
  })

  // ── Watch folders ─────────────────────────────────────────────────────────
  ipcMain.handle('library:setWatchFolders', (_e, paths: string[]): void => {
    saveSettings({ watchFolders: paths })
    startWatcher(paths)
  })

  ipcMain.handle('library:getWatchFolders', (): string[] => {
    return loadSettings().watchFolders
  })

  // ── Library Health ────────────────────────────────────────────────────────
  ipcMain.handle('library:scanMissingFiles', (): Track[] => {
    const rows = db.prepare('SELECT * FROM tracks').all() as Record<string, unknown>[]
    return rows
      .filter((r) => !existsSync(r.file_path as string))
      .map(rowToTrack)
  })

  ipcMain.handle('library:autoLocateMissing', async (_e, searchDir?: string): Promise<{ trackId: string; foundPath: string }[]> => {
    const { readdirSync, statSync } = await import('fs')
    const { basename } = await import('path')

    let resolvedDir = searchDir
    if (!resolvedDir) {
      const res = await dialog.showOpenDialog({ title: 'Choose search folder', properties: ['openDirectory'] })
      if (res.canceled) return []
      resolvedDir = res.filePaths[0]
    }

    const AUDIO_EXTS = new Set(['.mp3', '.flac', '.aiff', '.aif', '.wav', '.m4a', '.ogg'])

    // Build filename → absolute path map for all audio files under searchDir
    const fileMap = new Map<string, string>()
    const walk = (dir: string): void => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = `${dir}/${entry.name}`
          if (entry.isDirectory()) {
            walk(full)
          } else if (AUDIO_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) {
            fileMap.set(entry.name.toLowerCase(), full)
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
    walk(resolvedDir)

    const missingRows = (db.prepare('SELECT * FROM tracks').all() as Record<string, unknown>[])
      .filter((r) => !existsSync(r.file_path as string))
    void statSync   // satisfy import

    const results: { trackId: string; foundPath: string }[] = []
    for (const row of missingRows) {
      const oldPath = row.file_path as string
      const name = basename(oldPath).toLowerCase()
      const found = fileMap.get(name)
      if (found) {
        db.prepare("UPDATE tracks SET file_path = ?, updated_at = datetime('now') WHERE id = ?").run(found, row.id as string)
        results.push({ trackId: row.id as string, foundPath: found })
      }
    }
    return results
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

  // ── Beat analysis (ONNX) ─────────────────────────────────────────────────
  ipcMain.handle('library:beatModelStatus', (): { available: boolean; path: string } => ({
    available: isModelAvailable(),
    path: getDefaultModelPath()
  }))

  ipcMain.handle('library:warmBeatModel', (): void => {
    warmModel()
  })

  ipcMain.handle('library:analyzeBeats', async (_e, trackId: string): Promise<Track> => {
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as Record<string, unknown>
    if (!row) throw new Error(`Track not found: ${trackId}`)
    const track = rowToTrack(row)

    const result = await analyzeBeats(track.filePath)

    db.prepare(
      "UPDATE tracks SET beatgrid = ?, bpm = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(result.markers), result.detectedBpm || track.bpm, trackId)

    return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as Record<string, unknown>)
  })

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

  // ── Running Orders ────────────────────────────────────────────────────────

  type RORow = { id: string; catalog_num: number; title: string; entries: string; annotations: string; created_at: string; updated_at: string }
  type RO = import('../../shared/types').RunningOrder

  function rowToOrder(row: RORow): RO {
    return {
      id: row.id, catalogNum: row.catalog_num, title: row.title,
      entries: JSON.parse(row.entries), annotations: JSON.parse(row.annotations),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  ipcMain.handle('library:getRunningOrders', (): RO[] =>
    (db.prepare('SELECT * FROM running_orders ORDER BY catalog_num').all() as RORow[]).map(rowToOrder)
  )

  ipcMain.handle('library:createRunningOrder', (_e, title: string): RO => {
    const id = randomUUID()
    const next = ((db.prepare('SELECT COALESCE(MAX(catalog_num),0) as m FROM running_orders').get() as { m: number }).m) + 1
    db.prepare("INSERT INTO running_orders (id, catalog_num, title) VALUES (?,?,?)").run(id, next, title)
    return rowToOrder(db.prepare('SELECT * FROM running_orders WHERE id = ?').get(id) as RORow)
  })

  ipcMain.handle('library:updateRunningOrder', (_e, id: string, patch: Partial<RO>): RO => {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.title      !== undefined) { sets.push('title = ?');       vals.push(patch.title) }
    if (patch.entries    !== undefined) { sets.push('entries = ?');     vals.push(JSON.stringify(patch.entries)) }
    if (patch.annotations!== undefined) { sets.push('annotations = ?'); vals.push(JSON.stringify(patch.annotations)) }
    if (sets.length) {
      sets.push("updated_at = datetime('now')")
      db.prepare(`UPDATE running_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return rowToOrder(db.prepare('SELECT * FROM running_orders WHERE id = ?').get(id) as RORow)
  })

  ipcMain.handle('library:deleteRunningOrder', (_e, id: string): void => {
    db.prepare('DELETE FROM running_orders WHERE id = ?').run(id)
  })

  ipcMain.handle('library:exportOrderPDF', async (_e, id: string): Promise<{ saved: boolean; path?: string }> => {
    const row = db.prepare('SELECT * FROM running_orders WHERE id = ?').get(id) as RORow | undefined
    if (!row) return { saved: false }
    const order = rowToOrder(row)
    const trackIds = order.entries.map((e) => e.trackId)
    const tracks = trackIds.length
      ? (db.prepare(`SELECT * FROM tracks WHERE id IN (${trackIds.map(() => '?').join(',')})`).all(...trackIds) as Record<string, unknown>[]).map(rowToTrack)
      : []
    const trackMap = new Map(tracks.map((t) => [t.id, t]))

    const fmt = (s: number | null) => s ? `${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,'0')}` : '—'
    const rows = order.entries.map((e, i) => {
      const t = trackMap.get(e.trackId)
      return `<tr class="${i % 2 ? 'alt' : ''}${e.flexible ? ' flex' : ''}">
        <td class="num">${i + 1}</td>
        <td class="title">${t ? `<b>${t.title}</b><br><span class="artist">${t.artist}</span>` : e.trackId}</td>
        <td>${t?.bpm?.toFixed(1) ?? '—'}</td>
        <td>${t?.key ?? '—'}</td>
        <td>${t?.energy ?? '—'}</td>
        <td>${fmt(t?.durationSeconds ?? null)}</td>
        <td class="trans">${e.plannedTransition ? e.plannedTransition.kind : ''}</td>
        <td class="note">${e.note ?? ''}${e.flexible ? '<em> [flexible]</em>' : ''}</td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>N° ${String(order.catalogNum).padStart(3,'0')} · ${order.title}</title>
<style>
  body { font-family: 'Courier New', monospace; font-size: 9pt; color: #1a1a1a; margin: 12mm; }
  h1 { font-size: 14pt; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 2mm; }
  .sub { font-size: 8pt; color: #666; margin-bottom: 6mm; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; border-bottom: 1.5pt solid #1a1a1a; padding: 1.5mm 2mm; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.1em; }
  td { padding: 1.5mm 2mm; font-size: 8pt; border-bottom: 0.3pt solid #ddd; vertical-align: top; }
  .alt td { background: #f8f8f8; }
  .flex td { color: #888; }
  .num { width: 6mm; color: #999; }
  .title b { font-weight: bold; }
  .artist { font-size: 7pt; color: #666; }
  .trans { width: 18mm; font-size: 7pt; text-transform: uppercase; color: #888; }
  .note { font-size: 7pt; color: #666; font-style: italic; }
  .footer { margin-top: 6mm; font-size: 7pt; color: #999; text-align: right; }
</style></head><body>
<h1>N° ${String(order.catalogNum).padStart(3,'0')} &nbsp;·&nbsp; ${order.title}</h1>
<div class="sub">${order.entries.length} cuts &nbsp;·&nbsp; generated ${new Date().toISOString().slice(0,10)}</div>
<table>
<tr><th>#</th><th>Cut</th><th>BPM</th><th>Key</th><th>Nrg</th><th>Time</th><th>Into</th><th>Notes</th></tr>
${rows}
</table>
<div class="footer">Crate · running order</div>
</body></html>`

    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({ show: false })
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const pdfBuf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    win.close()

    const res = await dialog.showSaveDialog({
      title: 'Save running order PDF',
      defaultPath: `N${String(order.catalogNum).padStart(3,'0')}-${order.title.replace(/[^a-zA-Z0-9 ]/g,'').trim().replace(/ /g,'-')}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return { saved: false }
    require('fs').writeFileSync(res.filePath, pdfBuf)
    return { saved: true, path: res.filePath }
  })
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
    traktor: { name: 'Traktor Collection (NML)', extensions: ['nml'] },
    virtualdj: { name: 'VirtualDJ Database', extensions: ['xml'] }
  }
  return [map[id] ?? { name: 'All Files', extensions: ['*'] }]
}
