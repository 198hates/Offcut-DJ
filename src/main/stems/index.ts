/**
 * Stem separation via Demucs (HT-Demucs) — runs in Electron's MAIN process.
 *
 * Separation is offline + cached: the first time a track's stems are requested
 * we shell out to `python -m demucs`, write four stem WAVs into the userData
 * stems cache, and thereafter load them instantly. Requires Demucs installed in
 * the configured Python (`pip install demucs`); ffmpeg is used by Demucs to
 * decode non-wav inputs.
 */

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import type { StemKind } from '../../shared/types'

const MODEL = 'htdemucs'
const KINDS: StemKind[] = ['drums', 'bass', 'vocals', 'other']

export type StemPaths = Record<StemKind, string>

/**
 * In a packaged build we ship a self-contained PyInstaller bundle of Demucs
 * (+ PyTorch + the model) under Resources/offcut-demucs — no Python needed.
 * In dev we fall back to the configured Python's `python -m demucs`.
 */
function bundledDemucs(): { bin: string; torchHome: string } | null {
  if (!app.isPackaged) return null
  const dir = join(process.resourcesPath, 'offcut-demucs')
  const bin = join(dir, 'offcut-demucs')
  return existsSync(bin) ? { bin, torchHome: join(dir, 'torch-home') } : null
}

function stemsRoot(): string {
  return join(app.getPath('userData'), 'stems')
}

/** Where a track's four stems live once separated. */
function pathsFor(trackId: string): StemPaths {
  const dir = join(stemsRoot(), trackId, MODEL)
  return {
    drums: join(dir, 'drums.wav'),
    bass: join(dir, 'bass.wav'),
    vocals: join(dir, 'vocals.wav'),
    other: join(dir, 'other.wav')
  }
}

/** Return cached stem paths if all four exist, else null. */
export function cachedStems(trackId: string): StemPaths | null {
  const p = pathsFor(trackId)
  return KINDS.every((k) => existsSync(p[k])) ? p : null
}

/** Delete a track's cached stems. */
export function clearStems(trackId: string): void {
  try {
    rmSync(join(stemsRoot(), trackId), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** Probe whether stem separation is available (bundled binary, or Demucs in Python). */
export function demucsAvailable(pythonPath: string): Promise<boolean> {
  if (bundledDemucs()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let ok = false
    const proc = spawn(pythonPath, ['-c', 'import demucs, sys; sys.stdout.write(demucs.__version__)'])
    proc.stdout.on('data', () => (ok = true))
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(ok && code === 0))
  })
}

const inFlight = new Map<string, Promise<StemPaths>>()

/**
 * Separate a track into four stems (cached). De-dupes concurrent requests for
 * the same track. `onProgress(percent 0..100, label)` streams Demucs progress.
 */
/** Live Demucs children — killed on app quit so multi-minute separations
 *  aren't orphaned eating CPU after the window closes. */
const _liveProcs = new Set<import('child_process').ChildProcess>()

/** Kill any in-flight separations (call from app 'before-quit'). */
export function killAllSeparations(): void {
  for (const p of _liveProcs) {
    try { p.kill('SIGTERM') } catch { /* already gone */ }
  }
  _liveProcs.clear()
}

export function separateStems(
  trackId: string,
  filePath: string,
  pythonPath: string,
  onProgress?: (percent: number, label: string) => void
): Promise<StemPaths> {
  const cached = cachedStems(trackId)
  if (cached) return Promise.resolve(cached)
  const existing = inFlight.get(trackId)
  if (existing) return existing

  const run = new Promise<StemPaths>((resolve, reject) => {
    const outDir = join(stemsRoot(), trackId)
    try {
      mkdirSync(outDir, { recursive: true })
    } catch {
      /* ignore */
    }

    onProgress?.(0, 'starting Demucs…')
    const bundle = bundledDemucs()
    // -o <outDir> --filename "{stem}.{ext}" → <outDir>/htdemucs/{drums,bass,vocals,other}.wav
    const args = [
      ...(bundle ? [] : ['-m', 'demucs']),
      '-n',
      MODEL,
      // Preserve loudness: clamp rare transient peaks instead of rescaling the
      // whole output down (Demucs' default 'rescale' quietens hot/limited
      // masters — sometimes drastically when a separated stem peaks high).
      '--clip-mode',
      'clamp',
      '-o',
      outDir,
      '--filename',
      '{stem}.{ext}',
      filePath
    ]
    const cmd = bundle ? bundle.bin : pythonPath
    // Point the bundled run at the shipped model weights (fully offline).
    const env = bundle ? { ...process.env, TORCH_HOME: bundle.torchHome } : process.env
    const proc = spawn(cmd, args, { cwd: outDir, env })
    _liveProcs.add(proc)
    proc.on('close', () => _liveProcs.delete(proc))

    let stderr = ''
    const handleChunk = (buf: Buffer): void => {
      const s = buf.toString()
      stderr += s
      // Demucs prints a tqdm bar to stderr, e.g. " 42%|████ | ..."
      const matches = s.match(/(\d+)%/g)
      if (matches && matches.length) {
        const pct = parseInt(matches[matches.length - 1], 10)
        if (!Number.isNaN(pct)) onProgress?.(pct, 'separating stems…')
      }
    }
    proc.stdout.on('data', handleChunk)
    proc.stderr.on('data', handleChunk)

    proc.on('error', (err) => {
      const what = bundle ? 'the bundled separator' : `Python (${pythonPath})`
      reject(new Error(`Couldn't launch ${what}: ${err.message}`))
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        if (/No module named demucs|ModuleNotFoundError/i.test(stderr)) {
          reject(new Error('Demucs is not installed. Run: pip install demucs soundfile'))
        } else if (/appropriate backend|save_audio|backend to handle/i.test(stderr)) {
          reject(new Error('Demucs needs an audio writer. Run: pip install soundfile'))
        } else {
          reject(new Error(`Demucs failed (exit ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`))
        }
        return
      }
      const paths = cachedStems(trackId)
      if (!paths) {
        reject(new Error('Demucs finished but stem files were not found.'))
        return
      }
      onProgress?.(100, 'done')
      resolve(paths)
    })
  }).finally(() => inFlight.delete(trackId))

  inFlight.set(trackId, run)
  return run
}
