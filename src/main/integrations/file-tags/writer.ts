import { spawn } from 'child_process'
import { existsSync, renameSync, unlinkSync } from 'fs'
import { extname, dirname, basename } from 'path'
import { ffmpegBinary as ffmpegPath } from '../../ffmpeg'
import type { Track } from '../../../shared/types'

const SUPPORTED = new Set(['.mp3', '.flac', '.aif', '.aiff', '.m4a', '.aac', '.wav', '.ogg'])

export interface WriteTagsResult {
  success: boolean
  skipped?: boolean
  error?: string
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static not found')); return }
    const proc = spawn(ffmpegPath, args)
    const errLines: string[] = []
    proc.stderr.on('data', (d: Buffer) => errLines.push(d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(errLines.slice(-3).join(' ').trim() || `ffmpeg exited ${code}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Write Offcut metadata back into the audio file using ffmpeg's stream copy.
 * No audio is re-encoded — only the metadata container is rewritten.
 * Strategy: write to a sibling temp file, then atomically rename over the original.
 */
export async function writeTagsToFile(track: Track): Promise<WriteTagsResult> {
  const ext = extname(track.filePath).toLowerCase()

  if (!SUPPORTED.has(ext)) {
    return { success: false, skipped: true }
  }
  if (!existsSync(track.filePath)) {
    return { success: false, error: 'File not found on disk' }
  }

  // Temp file lives alongside the original so rename is always same-filesystem
  const tmpPath = `${dirname(track.filePath)}/.offcut_tmp_${basename(track.filePath)}`

  try {
    const args: string[] = [
      '-i', track.filePath,
      '-map', '0',             // copy all streams (audio + cover art)
      '-map_metadata', '0',    // start from existing tags, then override below
      '-c', 'copy',
    ]

    // Helper: always write the tag (empty string clears an existing value)
    const tag = (key: string, value: string | null | undefined): void => {
      args.push('-metadata', `${key}=${value ?? ''}`)
    }

    tag('title',       track.title   || null)
    tag('artist',      track.artist  || null)
    tag('album',       track.album   || null)
    tag('genre',       track.genre   || null)
    tag('comment',     track.comment || null)

    // Year — TDRC (ID3v2.4) / DATE (Vorbis) / (c) year (M4A) — ffmpeg maps 'date'
    if (track.year != null) tag('date', String(track.year))

    // Label — TPUB (ID3) / ORGANIZATION (Vorbis) — ffmpeg maps 'publisher'
    if (track.label) tag('publisher', track.label)

    // BPM — mapped to TBPM (MP3/ID3), BPM (FLAC Vorbis), tMPO (M4A) by ffmpeg
    if (track.bpm != null) tag('BPM', Math.round(track.bpm).toString())

    // Key — TKEY (ID3) / INITIALKEY (Vorbis). We store Camelot notation, write as-is.
    if (track.key) tag('INITIALKEY', track.key)

    // Energy — not a standard tag; write as custom TXXX/Vorbis comment
    if (track.energy != null) tag('OFFCUT_ENERGY', track.energy.toString())

    args.push('-y', tmpPath)

    await runFfmpeg(args)

    // Atomic replace
    renameSync(tmpPath, track.filePath)
    return { success: true }
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* already gone */ }
    return { success: false, error: (err as Error).message }
  }
}
