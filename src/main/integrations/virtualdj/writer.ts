/**
 * VirtualDJ 8 database export.
 *
 * Writes a single `database.xml` file in the VirtualDJ 8 format.
 * The user places the file in their VirtualDJ Documents folder
 * (usually ~/Documents/VirtualDJ/database.xml) and VDJ merges it
 * on the next launch.
 *
 * Format reference: VirtualDJ_Database Version="8"
 *   <Song FilePath="…">
 *     <Tags Author Artist Title Album Genre Comment Bpm Songlen />
 *     <Scan Bpm BeatOffset />          ← beatgrid anchor
 *     <Poi Pos Type Num Name Color />  ← cue/loop points
 *   </Song>
 */
import { writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { rowToTrack } from '../../library/db'
import type { Track, CuePoint, ExportResult } from '../../../shared/types'

export function exportToIntegration(appDb: Database.Database, outputPath: string): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  const trackRows = appDb.prepare('SELECT * FROM tracks ORDER BY artist, title').all() as Record<string, unknown>[]
  const tracks = trackRows.map(rowToTrack)

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<VirtualDJ_Database Version="8">')

  for (const track of tracks) {
    try {
      lines.push(trackToXml(track))
      result.tracksExported++
    } catch (err) {
      result.errors.push(`${track.title || track.filePath}: ${(err as Error).message}`)
    }
  }

  lines.push('</VirtualDJ_Database>')

  try {
    writeFileSync(outputPath, lines.join('\n'), 'utf8')
  } catch (err) {
    result.errors.push(`Write failed: ${(err as Error).message}`)
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────

function trackToXml(track: Track): string {
  const filePath = escapeXml(track.filePath)
  const children: string[] = []

  // <Tags> — core metadata
  const tagAttrs: string[] = [
    `Author="${escapeXml(track.artist)}"`,
    `Title="${escapeXml(track.title)}"`,
    `Album="${escapeXml(track.album)}"`,
    `Genre="${escapeXml(track.genre)}"`,
    `Comment="${escapeXml(track.comment)}"`,
  ]
  if (track.bpm != null)             tagAttrs.push(`Bpm="${track.bpm.toFixed(2)}"`)
  if (track.durationSeconds != null) tagAttrs.push(`Songlen="${track.durationSeconds.toFixed(3)}"`)
  if (track.rating > 0)              tagAttrs.push(`Rank="${track.rating}"`)
  children.push(`    <Tags ${tagAttrs.join(' ')} />`)

  // <Scan> — BPM + beatgrid anchor
  if (track.bpm != null) {
    const beatOffset = track.beatgrid.length > 0
      ? (track.beatgrid[0].positionMs / 1000).toFixed(3)
      : '0.000'
    children.push(`    <Scan Bpm="${track.bpm.toFixed(2)}" BeatOffset="${beatOffset}" />`)
  }

  // <Poi> — cue points
  for (const cue of track.cuePoints) {
    const poi = cueToXml(cue)
    if (poi) children.push(`    ${poi}`)
  }

  if (children.length === 0) {
    return `  <Song FilePath="${filePath}" />`
  }

  return [
    `  <Song FilePath="${filePath}">`,
    ...children,
    '  </Song>'
  ].join('\n')
}

function cueToXml(cue: CuePoint): string | null {
  const pos = (cue.positionMs / 1000).toFixed(3)
  const name = escapeXml(cue.label || '')
  const color = cue.color ? normaliseHex(cue.color) : '#FF8C00'

  if (cue.type === 'hotcue') {
    return `<Poi Pos="${pos}" Type="cue" Num="${cue.index}" Name="${name}" Color="${color}" />`
  }
  if (cue.type === 'loop') {
    // VDJ loops use LoopSize in beats; we store end-only, so emit as a cue
    return `<Poi Pos="${pos}" Type="cue" Num="${cue.index}" Name="${name}" Color="${color}" />`
  }
  if (cue.type === 'memory') {
    // Memory cues are unnumbered in VDJ
    return `<Poi Pos="${pos}" Type="cue" Num="-1" Name="${name}" Color="${color}" />`
  }
  return null
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Ensure color is #RRGGBB — VDJ doesn't accept shorthand or alpha */
function normaliseHex(hex: string): string {
  const h = hex.replace('#', '')
  if (h.length === 3) {
    const [r, g, b] = h.split('')
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  if (h.length >= 6) return `#${h.slice(0, 6).toUpperCase()}`
  return '#FF8C00'
}
