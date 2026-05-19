import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, CuePoint, ExportResult } from '../../../shared/types'

export function exportToIntegration(appDb: Database.Database, outputPath: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  const trackRows = appDb.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]
  const tracks = trackRows.map(rowToTrack)

  const playlistRows = appDb.prepare('SELECT * FROM playlists ORDER BY sort_order').all() as Record<string, unknown>[]

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<DJ_PLAYLISTS Version="1.0.0">')
  lines.push(`  <PRODUCT Name="DJ Library Manager" Version="0.1.0" Company="Between the Bridges"/>`)
  lines.push(`  <COLLECTION Entries="${tracks.length}">`)

  for (const track of tracks) {
    try {
      lines.push(trackToXml(track))
      result.tracksExported++
    } catch (err) {
      result.errors.push(`Track ${track.title}: ${(err as Error).message}`)
    }
  }

  lines.push('  </COLLECTION>')
  lines.push('  <PLAYLISTS>')
  lines.push('    <NODE Type="0" Name="ROOT" Count="1">')

  for (const pl of playlistRows) {
    const trackIds = (
      appDb.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order').all(pl.id as string) as { track_id: string }[]
    ).map((r) => r.track_id)

    const isFolder = Boolean(pl.is_folder)
    const type = isFolder ? '0' : '1'
    lines.push(`      <NODE Name="${escapeXml(String(pl.name))}" Type="${type}" KeyType="0" Entries="${trackIds.length}">`)

    for (const trackId of trackIds) {
      // Rekordbox XML uses TrackID as Key for playlist entries
      const t = tracks.find((tr) => tr.id === trackId)
      if (t) {
        const rbId = t.sourceIds.rekordbox ?? tracks.indexOf(t) + 1
        lines.push(`        <TRACK Key="${rbId}"/>`)
      }
    }

    lines.push('      </NODE>')
    result.playlistsExported++
  }

  lines.push('    </NODE>')
  lines.push('  </PLAYLISTS>')
  lines.push('</DJ_PLAYLISTS>')

  try {
    writeFileSync(outputPath, lines.join('\n'), 'utf8')
  } catch (err) {
    result.errors.push(`Write failed: ${(err as Error).message}`)
  }

  return result
}

function trackToXml(track: Track): string {
  const rbId = track.sourceIds.rekordbox ?? track.id
  const location = encodeRbLocation(track.filePath)
  const bpm = track.bpm != null ? track.bpm.toFixed(2) : ''
  const rating = starsToRbRating(track.rating)
  const duration = track.durationSeconds != null ? Math.round(track.durationSeconds) : ''

  const attrs = [
    `TrackID="${escapeXml(String(rbId))}"`,
    `Name="${escapeXml(track.title)}"`,
    `Artist="${escapeXml(track.artist)}"`,
    `Composer=""`,
    `Album="${escapeXml(track.album)}"`,
    `Grouping=""`,
    `Genre="${escapeXml(track.genre)}"`,
    `Kind="MP3 File"`,
    `Size=""`,
    `TotalTime="${duration}"`,
    `DiscNumber=""`,
    `TrackNumber=""`,
    `Year=""`,
    `AverageBpm="${bpm}"`,
    `DateAdded="${escapeXml(track.dateAdded.split('T')[0] || '')}"`,
    `BitRate=""`,
    `SampleRate=""`,
    `Comments="${escapeXml(track.comment)}"`,
    `PlayCount=""`,
    `Rating="${rating}"`,
    `Location="${escapeXml(location)}"`,
    `Remixer=""`,
    `Tonality="${escapeXml(track.key ?? '')}"`,
    `Label=""`,
    `Mix=""`
  ]

  const cueLines = track.cuePoints.map((c, i) => cueToXml(c, i))

  if (cueLines.length === 0) {
    return `    <TRACK ${attrs.join(' ')}/>`
  }

  return [
    `    <TRACK ${attrs.join(' ')}>`,
    ...cueLines,
    '    </TRACK>'
  ].join('\n')
}

function cueToXml(cue: CuePoint, fallbackIndex: number): string {
  const num = cue.type === 'hotcue' ? cue.index : -1
  const start = (cue.positionMs / 1000).toFixed(3)
  const type = cue.type === 'loop' ? '4' : cue.type === 'hotcue' ? '0' : '1'
  const [r, g, b] = hexToRgb(cue.color)
  return `      <POSITION_MARK Name="${escapeXml(cue.label)}" Type="${type}" Start="${start}" Num="${num}" Red="${r}" Green="${g}" Blue="${b}"/>`
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function encodeRbLocation(filePath: string): string {
  if (process.platform === 'darwin') {
    return `file://localhost${encodeURIComponent(filePath).replace(/%2F/g, '/')}`
  }
  return `file:///${encodeURIComponent(filePath.replace(/\\/g, '/')).replace(/%2F/g, '/')}`
}

function starsToRbRating(stars: number): number {
  const map: Record<number, number> = { 0: 0, 1: 51, 2: 102, 3: 153, 4: 204, 5: 255 }
  return map[stars] ?? 0
}

function hexToRgb(hex: string): [number, number, number] {
  const match = hex.replace('#', '').match(/.{2}/g)
  if (!match || match.length < 3) return [255, 140, 0]
  return [parseInt(match[0], 16), parseInt(match[1], 16), parseInt(match[2], 16)]
}
