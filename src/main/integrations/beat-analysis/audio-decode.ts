import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'

/** Safety ceiling — beyond this even a "track" is a recorded set; bounded so a
 *  multi-hour file can't OOM the main process (90 min mono f32 @22 050 ≈ 475 MB). */
const MAX_DECODE_SECONDS = 90 * 60

/**
 * Decode any audio file to mono 32-bit float PCM at the target sample rate.
 * Decodes the FULL track (the old 8-minute cap silently truncated beatgrids,
 * leaving everything past 8:00 gridless), and treats a non-zero ffmpeg exit
 * as an error instead of accepting partial output.
 */
export function decodeAudioToPcm(filePath: string, sampleRate: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return }

    const chunks: Buffer[] = []
    const stderrTail: string[] = []
    const proc = spawn(ffmpegPath, [
      '-i', filePath,
      '-t', String(MAX_DECODE_SECONDS),
      '-f', 'f32le',        // 32-bit float, little-endian
      '-ac', '1',           // mono
      '-ar', String(sampleRate),
      '-vn',                // skip video stream
      'pipe:1'
    ])

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (d: Buffer) => {
      // Keep only the tail — ffmpeg is verbose, but the last lines carry the error.
      stderrTail.push(d.toString())
      if (stderrTail.length > 8) stderrTail.shift()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        // A failed decode must fail loudly — accepting partial PCM used to
        // produce silently truncated beatgrids.
        const detail = stderrTail.join('').trim().split('\n').slice(-3).join(' · ')
        reject(new Error(`ffmpeg exited with code ${code}${detail ? `: ${detail}` : ''}`))
        return
      }
      const buf = Buffer.concat(chunks)
      // Copy into a fresh ArrayBuffer so the Float32Array owns its memory
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      resolve(new Float32Array(ab))
    })
    proc.on('error', reject)
  })
}
