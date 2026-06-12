import { readdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import { parseSeratoTagsFromFile } from './geob'
import type { Track, ImportResult } from '../../../shared/types'

export function importFromIntegration(appDb: Database.Database, seratoDir: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  const subcratePath = join(seratoDir, 'Subcrates')
  let crateFiles: string[]
  try {
    crateFiles = readdirSync(subcratePath).filter((f) => f.endsWith('.crate'))
  } catch {
    result.errors.push(`Cannot read Serato Subcrates directory: ${subcratePath}`)
    return result
  }

  const insertTrack = appDb.transaction((track: Track) => insertOrUpdateTrack(appDb, track))

  for (const crateFile of crateFiles) {
    try {
      const crateName = basename(crateFile, '.crate')
      const buf = readFileSync(join(subcratePath, crateFile))
      const trackPaths = parseCrateFile(buf)

      const playlistId = randomUUID()
      appDb.prepare(`
        INSERT OR REPLACE INTO playlists (id, name, is_folder, sort_order, source_ids)
        VALUES (?, ?, 0, 0, ?)
      `).run(playlistId, crateName, JSON.stringify({ serato: crateFile }))

      trackPaths.forEach((filePath, order) => {
        const existingRow = appDb
          .prepare('SELECT id FROM tracks WHERE file_path = ?')
          .get(filePath) as { id: string } | undefined

        const trackId = existingRow?.id ?? (() => {
          const id = randomUUID()
          const geob = parseSeratoTagsFromFile(filePath)
          const track: Track = {
            id,
            filePath,
            title: basename(filePath, filePath.includes('.') ? `.${filePath.split('.').pop()}` : ''),
            artist: '',
            album: '',
            genre: '',
            year: null,
            label: '',
            bpm: geob.bpm,
            key: null,
            durationSeconds: null,
            rating: 0,
            dateAdded: new Date().toISOString(),
            comment: '',
            tags: [],
            customTags: {},
            cuePoints: geob.cuePoints,
            beatgrid: geob.beatgrid,
            energy: null,
            danceability: null,
            mood: null,
            analysedBeatgrid: null,
            editLineage: null,
            color: '',
            playCount: 0,
            lastPlayedAt: null,
            updatedAt: null,
            fileSize: null,
            fileType: null,
            sampleRate: null,
            bitDepth: null,
            gainDb: null,
            phrases: null,
            sourceIds: { serato: filePath }
          }
          insertTrack(track)
          result.tracksImported++
          return id
        })()

        appDb.prepare(
          'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
        ).run(playlistId, trackId, order)
      })

      result.playlistsImported++
    } catch (err) {
      result.errors.push(`Crate ${crateFile}: ${(err as Error).message}`)
    }
  }

  return result
}

function parseCrateFile(buf: Buffer): string[] {
  const paths: string[] = []
  let offset = 0

  while (offset + 8 <= buf.length) {
    const tag = buf.toString('ascii', offset, offset + 4)
    const length = buf.readUInt32BE(offset + 4)
    offset += 8

    if (offset + length > buf.length) break

    if (tag === 'otrk') {
      const trackPath = parseTrackRecord(buf.subarray(offset, offset + length))
      if (trackPath) paths.push(trackPath)
    }

    offset += length
  }

  return paths
}

function parseTrackRecord(buf: Buffer): string | null {
  let offset = 0
  while (offset + 8 <= buf.length) {
    const tag = buf.toString('ascii', offset, offset + 4)
    const length = buf.readUInt32BE(offset + 4)
    offset += 8
    if (offset + length > buf.length) break
    if (tag === 'ptrk') {
      return buf.toString('utf16le', offset, offset + length)
    }
    offset += length
  }
  return null
}
