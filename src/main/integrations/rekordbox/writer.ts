import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, CuePoint, ExportResult } from '../../../shared/types'

export interface RbPlaylist {
  name: string
  isFolder: boolean
  trackIds: string[]
}

export function exportToIntegration(appDb: Database.Database, outputPath: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  const trackRows = appDb.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]
  const tracks = trackRows.map(rowToTrack)

  const playlistRows = appDb.prepare('SELECT * FROM playlists ORDER BY sort_order').all() as Record<string, unknown>[]
  const playlists: RbPlaylist[] = playlistRows.map((pl) => ({
    name: String(pl.name),
    isFolder: Boolean(pl.is_folder),
    trackIds: (
      appDb
        .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order')
        .all(pl.id as string) as { track_id: string }[]
    ).map((r) => r.track_id)
  }))

  try {
    const xml = buildRekordboxXml(tracks, playlists, result)
    writeFileSync(outputPath, xml, 'utf8')
  } catch (err) {
    result.errors.push(`Write failed: ${(err as Error).message}`)
  }

  return result
}

/**
 * Build a Rekordbox `DJ_PLAYLISTS` XML document. Pure (no I/O) so it can be
 * unit-tested. Every track is assigned ONE Rekordbox id — its real rekordbox
 * source id if present, otherwise a 1-based index — and that same id is written
 * both as the COLLECTION `TrackID` and as each playlist entry's `Key`. With
 * `KeyType="0"`, Rekordbox resolves playlist entries by `Key == TrackID`, so the
 * two must agree or playlists import empty.
 */
export function buildRekordboxXml(
  tracks: Track[],
  playlists: RbPlaylist[],
  result?: ExportResult
): string {
  const rbIdByTrackId = new Map<string, string>()
  tracks.forEach((t, i) => {
    rbIdByTrackId.set(t.id, String(t.sourceIds.rekordbox ?? i + 1))
  })

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<DJ_PLAYLISTS Version="1.0.0">')
  lines.push(`  <PRODUCT Name="Offcut" Version="0.1.0" Company="Offcut"/>`)
  lines.push(`  <COLLECTION Entries="${tracks.length}">`)

  for (const track of tracks) {
    try {
      lines.push(trackToXml(track, rbIdByTrackId.get(track.id)!))
      if (result) result.tracksExported++
    } catch (err) {
      if (result) result.errors.push(`Track ${track.title}: ${(err as Error).message}`)
    }
  }

  lines.push('  </COLLECTION>')
  lines.push('  <PLAYLISTS>')
  lines.push('    <NODE Type="0" Name="ROOT" Count="1">')

  for (const pl of playlists) {
    const type = pl.isFolder ? '0' : '1'
    const keys = pl.trackIds.map((id) => rbIdByTrackId.get(id)).filter((k): k is string => k != null)
    lines.push(`      <NODE Name="${escapeXml(pl.name)}" Type="${type}" KeyType="0" Entries="${keys.length}">`)
    for (const key of keys) {
      lines.push(`        <TRACK Key="${escapeXml(key)}"/>`)
    }
    lines.push('      </NODE>')
    if (result) result.playlistsExported++
  }

  lines.push('    </NODE>')
  lines.push('  </PLAYLISTS>')
  lines.push('</DJ_PLAYLISTS>')
  return lines.join('\n')
}

function trackToXml(track: Track, rbId: string): string {
  const location = encodeRbLocation(track.filePath)
  const bpm = track.bpm != null ? track.bpm.toFixed(2) : ''
  const rating = starsToRbRating(track.rating)
  const duration = track.durationSeconds != null ? Math.round(track.durationSeconds) : ''

  const attrs = [
    `TrackID="${escapeXml(rbId)}"`,
    `Name="${escapeXml(track.title)}"`,
    `Artist="${escapeXml(track.artist)}"`,
    `Composer=""`,
    `Album="${escapeXml(track.album)}"`,
    `Grouping=""`,
    `Genre="${escapeXml(track.genre)}"`,
    `Kind="${rbKind(track.filePath)}"`,
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

  const cueLines = track.cuePoints.map((c) => cueToXml(c))

  if (cueLines.length === 0) {
    return `    <TRACK ${attrs.join(' ')}/>`
  }

  return [`    <TRACK ${attrs.join(' ')}>`, ...cueLines, '    </TRACK>'].join('\n')
}

function cueToXml(cue: CuePoint): string {
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

/** Rekordbox's `Kind` string, by file extension. */
function rbKind(filePath: string): string {
  switch (filePath.split('.').pop()?.toLowerCase()) {
    case 'm4a':
    case 'aac':
      return 'M4A File'
    case 'wav':
      return 'WAV File'
    case 'aif':
    case 'aiff':
      return 'AIFF File'
    case 'flac':
      return 'FLAC File'
    default:
      return 'MP3 File'
  }
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
