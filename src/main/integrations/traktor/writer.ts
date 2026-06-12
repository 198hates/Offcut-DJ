import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, CuePoint, ExportResult } from '../../../shared/types'

export function exportToIntegration(appDb: Database.Database, outputPath: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  const trackRows = appDb.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]
  const tracks = trackRows.map(rowToTrack)

  const playlistRows = appDb.prepare(`
    SELECT p.*, GROUP_CONCAT(pt.track_id ORDER BY pt.sort_order) AS track_id_list
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    WHERE p.is_folder = 0
    GROUP BY p.id
    ORDER BY p.sort_order
  `).all() as (Record<string, unknown> & { track_id_list: string | null })[]

  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  const lines: string[] = []

  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no" ?>')
  lines.push(`<NML Version="19" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://10.0.0.1/" MODIFIED_BY="Offcut">`)
  lines.push(`  <HEAD COMPANY="Offcut" PROGRAM="Offcut"></HEAD>`)
  lines.push(`  <MUSICFOLDERS></MUSICFOLDERS>`)
  lines.push(`  <COLLECTION ENTRIES="${tracks.length}">`)

  for (const track of tracks) {
    try {
      lines.push(trackToNml(track, now))
      result.tracksExported++
    } catch (err) {
      result.errors.push(`Track ${track.title}: ${(err as Error).message}`)
    }
  }

  lines.push('  </COLLECTION>')
  lines.push('  <SETS ENTRIES="0"></SETS>')
  lines.push(`  <PLAYLISTS>`)
  lines.push(`    <NODE TYPE="FOLDER" NAME="$ROOT">`)

  for (const pl of playlistRows) {
    const trackIds = pl.track_id_list ? pl.track_id_list.split(',') : []
    lines.push(`      <NODE TYPE="PLAYLIST" NAME="${escapeXml(String(pl.name))}" ENTRIES="${trackIds.length}" SORTING="0">`)

    for (const trackId of trackIds) {
      const t = tracks.find((tr) => tr.id === trackId)
      if (t) {
        lines.push(`        <ENTRY>`)
        lines.push(`          <PRIMARYKEY TYPE="TRACK" KEY="${escapeXml(buildTraktorKey(t))}"></PRIMARYKEY>`)
        lines.push(`        </ENTRY>`)
      }
    }

    lines.push(`      </NODE>`)
    result.playlistsExported++
  }

  lines.push('    </NODE>')
  lines.push('  </PLAYLISTS>')
  lines.push('</NML>')

  try {
    writeFileSync(outputPath, lines.join('\n'), 'utf8')
  } catch (err) {
    result.errors.push(`Write failed: ${(err as Error).message}`)
  }

  return result
}

function trackToNml(track: Track, dateModified: string): string {
  const { volume, dir, file } = splitTraktorPath(track.filePath)
  const ranking = starsToTraktorRanking(track.rating)
  const key = track.key ? nameToTraktorKey(track.key) : ''

  const cueLines = track.cuePoints.map(cueToNml).join('\n')
  const tempoLine = track.bpm != null
    ? `    <TEMPO BPM="${track.bpm.toFixed(6)}" BPM_QUALITY="100"></TEMPO>`
    : ''
  const keyLine = key !== '' ? `    <MUSICAL_KEY VALUE="${key}"></MUSICAL_KEY>` : ''

  return [
    `    <ENTRY MODIFIED_DATE="${dateModified}" MODIFIED_TIME="0" AUDIO_ID="" TITLE="${escapeXml(track.title)}" ARTIST="${escapeXml(track.artist)}">`,
    `      <LOCATION DIR="${escapeXml(dir)}" FILE="${escapeXml(file)}" VOLUME="${escapeXml(volume)}" VOLUMEID="${escapeXml(volume)}"></LOCATION>`,
    `      <ALBUM TRACK="0" TITLE="${escapeXml(track.album)}"></ALBUM>`,
    `      <INFO BITRATE="" GENRE="${escapeXml(track.genre)}" COMMENT="${escapeXml(track.comment)}" PLAYCOUNT="0" PLAYTIME="${track.durationSeconds ? Math.round(track.durationSeconds) : 0}" PLAYTIME_FLOAT="${track.durationSeconds ?? 0}" IMPORT_DATE="${track.dateAdded.split('T')[0] || ''}" RANKING="${ranking}" LAST_PLAYED="" RELEASE_DATE="" FILESIZE=""></INFO>`,
    tempoLine,
    keyLine,
    cueLines,
    '    </ENTRY>'
  ].filter(Boolean).join('\n')
}

function cueToNml(cue: CuePoint): string {
  const start = (cue.positionMs / 1000).toFixed(6)
  const hotcue = cue.type === 'hotcue' ? cue.index : -1
  const type = cue.type === 'loop' ? '4' : cue.type === 'hotcue' ? '0' : '3'
  const color = cue.color.replace('#', '').toUpperCase()
  return `      <CUE_V2 NAME="${escapeXml(cue.label)}" DISPL_ORDER="0" TYPE="${type}" START="${start}" LEN="0.000000" REPEATS="-1" HOTCUE="${hotcue}" COLOR="#${color}"></CUE_V2>`
}

function splitTraktorPath(filePath: string): { volume: string; dir: string; file: string } {
  if (process.platform === 'win32') {
    const parts = filePath.replace(/\\/g, '/').split('/')
    const volume = parts[0].replace(':', '') // e.g., "C"
    const file = parts.pop() ?? ''
    const dir = '/:' + parts.slice(1).join('/') + '/'
    return { volume, dir, file }
  }
  // macOS/Linux: /Volumes/Drive/path/to/file.mp3
  const parts = filePath.split('/')
  const file = parts.pop() ?? ''
  // Traktor uses volume name as the drive; for local files it's typically the disk name
  const volume = parts[2] ?? '' // e.g., "Macintosh HD" or drive name
  const dir = '/: ' + parts.slice(3).join('/') + '/'
  return { volume, dir, file }
}

function buildTraktorKey(track: Track): string {
  const { volume, dir, file } = splitTraktorPath(track.filePath)
  return `${volume}${dir}${file}`
}

function starsToTraktorRanking(stars: number): number {
  return Math.round((stars / 5) * 255)
}

function nameToTraktorKey(key: string): number {
  const keys: Record<string, number> = {
    '1d': 0,'8d': 1,'3d': 2,'10d': 3,'5d': 4,'12d': 5,'7d': 6,
    '2d': 7,'9d': 8,'4d': 9,'11d': 10,'6d': 11,
    '1m': 12,'8m': 13,'3m': 14,'10m': 15,'5m': 16,'12m': 17,'7m': 18,
    '2m': 19,'9m': 20,'4m': 21,'11m': 22,'6m': 23
  }
  return keys[key.toLowerCase()] ?? 0
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
