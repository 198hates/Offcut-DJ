/**
 * On-demand installer for the Beat This! ONNX model (beat_this.onnx).
 *
 * Bundling the ~80 MB model into every installer would bloat them, so we ship
 * lean and let the user pull it once, on demand, from Analyse → Beat Grid. It
 * downloads to userData/models/beat_this.onnx — exactly where
 * `getDefaultModelPath()` looks first — so no rebuild or Python export is
 * needed. Mirrors the stems-pack on-demand pattern (src/main/stems/installer).
 */

import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import { app } from 'electron'

// Hosted as a GitHub Release asset (no Python required). Override at runtime
// with OFFCUT_MODEL_BASE to point at a staging host without rebuilding.
const DEFAULT_MODEL_BASE = 'https://github.com/198hates/Offcut-DJ/releases/download/models-v1'

function modelBase(): string {
  return (process.env.OFFCUT_MODEL_BASE || DEFAULT_MODEL_BASE).replace(/\/+$/, '')
}

export function beatModelUrl(): string {
  return `${modelBase()}/beat_this.onnx`
}

/** Download `url` to `dest`, following redirects, reporting 0..1 fractional progress. */
function download(url: string, dest: string, onFrac: (frac: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'))
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0
      // GitHub asset URLs 302-redirect to a signed object-store URL.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        download(next, dest, onFrac, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`download failed (HTTP ${status}) — is the model release published yet?`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (total > 0) onFrac(got / total)
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

/**
 * Download beat_this.onnx into userData/models. `onProgress` streams percent
 * 0..100 with a label. Resolves to the installed model path. Downloads to a
 * `.part` file in the same dir and renames on completion, so an interrupted
 * download never leaves a half-written file that looks like a valid model.
 */
export async function installBeatModel(
  onProgress?: (percent: number, label: string) => void
): Promise<string> {
  const dir = join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'beat_this.onnx')
  const part = `${dest}.part`

  onProgress?.(0, 'downloading beat model…')
  try {
    await download(beatModelUrl(), part, (frac) =>
      onProgress?.(Math.round(frac * 100), 'downloading beat model…')
    )
    renameSync(part, dest)
  } catch (e) {
    try { rmSync(part, { force: true }) } catch { /* ignore */ }
    throw e
  }
  onProgress?.(100, 'installed')
  return dest
}
