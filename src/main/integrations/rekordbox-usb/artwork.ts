// Album-art extraction for the Rekordbox USB export. Reads embedded cover art
// from a track and normalises it to a small JPEG (rekordbox stores art as JPEG;
// the CDJ won't render PNG), so the player shows artwork on the deck and browser.

import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'

/** Read the first embedded picture from a track, or null if it has none. */
export async function readEmbeddedArt(audioPath: string): Promise<Buffer | null> {
  try {
    const { parseFile } = await import('music-metadata')
    const meta = await parseFile(audioPath, { duration: false })
    const pic = meta.common.picture?.[0]
    if (!pic?.data?.length) return null
    return Buffer.from(pic.data)
  } catch {
    return null
  }
}

/**
 * Convert/downscale arbitrary embedded image bytes to a CDJ-friendly JPEG
 * (≤ 500 px, original aspect) via ffmpeg. Returns null if conversion fails.
 */
export function toStickJpeg(input: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(null)
      return
    }
    const out: Buffer[] = []
    const proc = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-vf', 'scale=w=500:h=500:force_original_aspect_ratio=decrease',
      '-frames:v', '1',
      '-f', 'mjpeg',
      'pipe:1'
    ])
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null))
    proc.on('error', () => resolve(null))
    proc.stdin.on('error', () => {}) // ffmpeg may close stdin early on bad input
    proc.stdin.end(input)
  })
}
