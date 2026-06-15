// Import a USB backup folder (the structure a Rekordbox stick has) into Offcut's
// library: tracks with their Rekordbox metadata (BPM/key/genre/rating), beat
// grids and cues from the ANLZ files, and the playlist tree.

import { readFileSync, statSync } from 'fs'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import { resolveExportPdb, parseExportPdb } from './reader'
import { readAnlzAnalysis } from './anlz-reader'
import type { Track, ImportResult, UsbPlaylistNode } from '../../../shared/types'

/** Resolve a device-relative path (e.g. /Contents/x.mp3) to a real path in the backup. */
function devicePath(backupRoot: string, deviceRelative: string): string {
  return join(backupRoot, deviceRelative.replace(/^\/+/, ''))
}

export interface ImportProgress {
  phase: 'tracks' | 'playlists'
  current: number
  total: number
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export async function importFromUsbBackup(
  appDb: Database.Database,
  backupRoot: string,
  opts: { includeAnalysis?: boolean; onProgress?: (p: ImportProgress) => void } = {}
): Promise<ImportResult> {
  const includeAnalysis = opts.includeAnalysis !== false
  const onProgress = opts.onProgress
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  const pdbPath = resolveExportPdb(backupRoot)
  if (!pdbPath) {
    result.errors.push('No Rekordbox database (PIONEER/rekordbox/export.pdb) found in this folder.')
    return result
  }

  const tStart = Date.now()
  let parsed: ReturnType<typeof parseExportPdb>
  try {
    parsed = parseExportPdb(readFileSync(pdbPath))
  } catch (err) {
    result.errors.push(`Couldn't read the backup database: ${(err as Error).message}`)
    return result
  }
  console.log(`[usb-import] parsed ${parsed.tracks.length} tracks / ${parsed.playlists.length} top-level playlists in ${Date.now() - tStart}ms`)
  const tTracks = Date.now()

  const findByPath = appDb.prepare('SELECT id FROM tracks WHERE file_path = ?')
  const pdbIdToInternal = new Map<number, string>()

  // Import tracks in chunks, yielding to the event loop between chunks so the UI
  // stays responsive and progress events flush (a full backup is thousands).
  const CHUNK = 200
  const total = parsed.tracks.length
  for (let start = 0; start < total; start += CHUNK) {
    const chunk = parsed.tracks.slice(start, start + CHUNK)
    appDb.transaction(() => {
      for (const t of chunk) {
        try {
          const audioPath = devicePath(backupRoot, t.filePath)
          const existing = findByPath.get(audioPath) as { id: string } | undefined
          const id = existing?.id ?? randomUUID()
          pdbIdToInternal.set(t.id, id)

          let beatgrid: Track['beatgrid'] = []
          let cuePoints: Track['cuePoints'] = []
          if (includeAnalysis && t.analyzePath) {
            const a = readAnlzAnalysis(devicePath(backupRoot, t.analyzePath))
            beatgrid = a.beatgrid
            cuePoints = a.cuePoints
          }

          let fileSize: number | null = null
          try {
            fileSize = statSync(audioPath).size
          } catch {
            /* audio missing from backup — still import the metadata */
          }

          const track: Track = {
            id,
            filePath: audioPath,
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre,
            year: t.year,
            label: '',
            bpm: t.bpm,
            key: t.key || null,
            durationSeconds: t.durationSeconds,
            rating: t.rating,
            dateAdded: new Date().toISOString(),
            comment: '',
            tags: [],
            customTags: {},
            cuePoints,
            beatgrid,
            energy: null,
            danceability: null,
            mood: null,
            analysedBeatgrid: null,
            editLineage: null,
            color: '',
            playCount: 0,
            lastPlayedAt: null,
            updatedAt: null,
            fileSize,
            fileType: extname(audioPath).replace('.', '').toLowerCase() || null,
            sampleRate: null,
            bitDepth: null,
            gainDb: null,
            phrases: null,
            embedding: null,
            sourceIds: { rekordbox: String(t.id) }
          }
          insertOrUpdateTrack(appDb, track)
          result.tracksImported++
        } catch (err) {
          if (result.errors.length === 0) {
            console.log(`[usb-import] FIRST track error on "${t.title}": ${(err as Error).message}`)
          }
          result.errors.push(`Track "${t.title}": ${(err as Error).message}`)
        }
      }
    })()
    onProgress?.({ phase: 'tracks', current: Math.min(start + CHUNK, total), total })
    await yieldToLoop()
  }

  // Playlist tree — dedupe by (name, parent) so re-importing updates in place.
  const findPlaylist = appDb.prepare(
    'SELECT id FROM playlists WHERE name = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)'
  )
  const insertPlaylist = appDb.prepare(`
    INSERT OR REPLACE INTO playlists (id, name, is_folder, is_smart, parent_id, sort_order, source_ids)
    VALUES (?, ?, ?, 0, ?, ?, '{}')
  `)
  const clearTracks = appDb.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?')
  const addTrack = appDb.prepare(
    'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
  )

  const importNodes = (nodes: UsbPlaylistNode[], parentId: string | null): void => {
    nodes.forEach((n, order) => {
      const found = findPlaylist.get(n.name, parentId, parentId) as { id: string } | undefined
      const id = found?.id ?? randomUUID()
      insertPlaylist.run(id, n.name, n.isFolder ? 1 : 0, parentId, order)
      if (n.isFolder) {
        importNodes(n.children ?? [], id)
      } else {
        clearTracks.run(id)
        ;(n.trackIds ?? []).forEach((pdbId, i) => {
          const internal = pdbIdToInternal.get(pdbId)
          if (internal) addTrack.run(id, internal, i)
        })
        result.playlistsImported++
      }
    })
  }
  console.log(`[usb-import] imported ${result.tracksImported} tracks in ${Date.now() - tTracks}ms`)
  const tPl = Date.now()
  onProgress?.({ phase: 'playlists', current: 0, total: parsed.playlists.length })
  await yieldToLoop()
  appDb.transaction(() => importNodes(parsed.playlists, null))()
  console.log(`[usb-import] rebuilt ${result.playlistsImported} playlists in ${Date.now() - tPl}ms · total ${Date.now() - tStart}ms`)

  return result
}
