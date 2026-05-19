/**
 * M3U / M3U8 playlist export.
 *
 * M3U is the most universal playlist format — supported by VLC, Windows Media
 * Player, djay Pro, and most DJ software via import. M3U8 is identical but
 * explicitly UTF-8 encoded (preferred).
 *
 * Exports each playlist as a separate .m3u8 file in the chosen directory,
 * plus an optional "All Tracks" M3U8.
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, ExportResult } from '../../../shared/types'

export function exportToIntegration(appDb: Database.Database, outputDir: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  try {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
  } catch (err) {
    result.errors.push(`Cannot create output directory: ${(err as Error).message}`)
    return result
  }

  const playlists = appDb
    .prepare("SELECT * FROM playlists WHERE is_folder = 0 ORDER BY sort_order")
    .all() as Record<string, unknown>[]

  for (const pl of playlists) {
    try {
      const trackRows = appDb
        .prepare(`
          SELECT t.* FROM tracks t
          JOIN playlist_tracks pt ON pt.track_id = t.id
          WHERE pt.playlist_id = ?
          ORDER BY pt.sort_order
        `)
        .all(pl.id as string) as Record<string, unknown>[]

      const tracks = trackRows.map(rowToTrack)
      const filename = sanitizeFilename(String(pl.name)) + '.m3u8'
      writeFileSync(join(outputDir, filename), buildM3U(tracks, String(pl.name)), 'utf8')
      result.tracksExported += tracks.length
      result.playlistsExported++
    } catch (err) {
      result.errors.push(`Playlist ${pl.name}: ${(err as Error).message}`)
    }
  }

  // Also write an "All Tracks" M3U8
  try {
    const allRows = appDb
      .prepare('SELECT * FROM tracks ORDER BY artist, title')
      .all() as Record<string, unknown>[]
    const allTracks = allRows.map(rowToTrack)
    writeFileSync(join(outputDir, 'All Tracks.m3u8'), buildM3U(allTracks, 'All Tracks'), 'utf8')
    result.playlistsExported++
  } catch (err) {
    result.errors.push(`All Tracks: ${(err as Error).message}`)
  }

  return result
}

function buildM3U(tracks: Track[], title: string): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${title}`]
  for (const track of tracks) {
    const duration = track.durationSeconds != null ? Math.round(track.durationSeconds) : -1
    const label = [track.artist, track.title].filter(Boolean).join(' - ') || track.filePath.split('/').pop() || ''
    lines.push(`#EXTINF:${duration},${label}`)
    lines.push(track.filePath)
  }
  return lines.join('\n') + '\n'
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled'
}
