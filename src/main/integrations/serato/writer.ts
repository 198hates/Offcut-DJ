import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, ExportResult } from '../../../shared/types'

// Serato crate format: sequence of tagged records
// tag (4 ASCII bytes) + length (4 bytes big-endian) + data
//
// vrsn: version string (UTF-16 LE)
// otrk: track container (contains ptrk)
// ptrk: track path (UTF-16 LE, relative to Music folder)

const CRATE_VERSION = '1.0/Serato ScratchLive Crate\0'

export function exportToIntegration(appDb: Database.Database, seratoDir: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  const subcratePath = join(seratoDir, 'Subcrates')
  try {
    if (!existsSync(subcratePath)) mkdirSync(subcratePath, { recursive: true })
  } catch (err) {
    result.errors.push(`Cannot create Subcrates directory: ${(err as Error).message}`)
    return result
  }

  const playlists = appDb
    .prepare('SELECT * FROM playlists WHERE is_folder = 0 ORDER BY sort_order')
    .all() as Record<string, unknown>[]

  for (const pl of playlists) {
    try {
      const trackRows = appDb
        .prepare('SELECT t.* FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ? ORDER BY pt.sort_order')
        .all(pl.id as string) as Record<string, unknown>[]

      const tracks = trackRows.map(rowToTrack)
      const crateData = buildCrateBuffer(tracks)
      const crateName = sanitizeCrateName(String(pl.name))
      writeFileSync(join(subcratePath, `${crateName}.crate`), crateData)
      result.tracksExported += tracks.length
      result.playlistsExported++
    } catch (err) {
      result.errors.push(`Playlist ${pl.name}: ${(err as Error).message}`)
    }
  }

  if (playlists.length === 0) {
    // Export all tracks as one crate if no playlists
    try {
      const allRows = appDb.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]
      const tracks = allRows.map(rowToTrack)
      const crateData = buildCrateBuffer(tracks)
      writeFileSync(join(subcratePath, 'All Tracks.crate'), crateData)
      result.tracksExported = tracks.length
      result.playlistsExported = 1
    } catch (err) {
      result.errors.push(`All Tracks crate: ${(err as Error).message}`)
    }
  }

  return result
}

function buildCrateBuffer(tracks: Track[]): Buffer {
  const chunks: Buffer[] = []

  chunks.push(makeRecord('vrsn', encodeUtf16(CRATE_VERSION)))

  for (const track of tracks) {
    const pathData = encodeUtf16(track.filePath)
    const ptrkRecord = makeRecord('ptrk', pathData)
    chunks.push(makeRecord('otrk', ptrkRecord))
  }

  return Buffer.concat(chunks)
}

function makeRecord(tag: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(tag, 0, 'ascii')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function encodeUtf16(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2)
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2)
  }
  return buf
}

function sanitizeCrateName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_')
}

export function getDefaultSeratoDir(): string {
  if (process.platform === 'darwin') {
    return join(process.env.HOME ?? '', 'Music', '_Serato_')
  }
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Music', '_Serato_')
}
