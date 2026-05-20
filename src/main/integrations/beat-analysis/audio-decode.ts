import { spawn } from 'child_process'
import ffmpegPath from 'ffmpeg-static'

/** Decode any audio file to mono 32-bit float PCM at the target sample rate */
export function decodeAudioToPcm(filePath: string, sampleRate: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('ffmpeg-static binary not found')); return }

    const chunks: Buffer[] = []
    const proc = spawn(ffmpegPath, [
      '-i', filePath,
      '-t', '480',          // cap at 8 minutes — sufficient for beat detection, prevents OOM on long mixes
      '-f', 'f32le',        // 32-bit float, little-endian
      '-ac', '1',           // mono
      '-ar', String(sampleRate),
      '-vn',                // skip video stream
      'pipe:1'
    ])

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', () => {}) // suppress — ffmpeg is verbose on stderr
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`ffmpeg exited with code ${code}`))
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
