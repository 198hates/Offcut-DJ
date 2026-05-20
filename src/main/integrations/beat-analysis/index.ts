import { Worker } from 'worker_threads'
import { join } from 'path'
import { isModelAvailable, getDefaultModelPath } from './beat-model'
import type { BeatgridMarker } from '../../../shared/types'

export { isModelAvailable, getDefaultModelPath }

export interface BeatAnalysisResult {
  markers: BeatgridMarker[]
  durationMs: number
  detectedBpm: number
  barCount: number
  confidence: number
}

/**
 * Persistent worker — the model is loaded once and reused across all tracks.
 *
 * Previous architecture spawned one worker per track: the ONNX model was
 * loaded from disk on every call (~100 MB each time), and the main process
 * also created its own ONNX session via warmModel(), causing native-level
 * conflicts between main-thread and worker-thread ONNX state that crashed
 * the Electron process after a few tracks.
 *
 * Now: one long-lived worker owns all ONNX state. Main process never
 * touches onnxruntime. If the worker crashes (native ONNX bug), it is
 * restarted transparently for the next track without killing the app.
 */

type PendingRequest = {
  resolve: (r: BeatAnalysisResult) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const TIMEOUT_MS    = 5 * 60_000   // 5 min hard limit per track
const WORKER_PATH   = join(__dirname, 'beat-analysis-worker.js')

let _worker:  Worker | null = null
let _pending: PendingRequest | null = null

function spawnWorker(): Worker {
  const worker = new Worker(WORKER_PATH, {
    workerData: { modelPath: getDefaultModelPath() }
  })

  worker.on('message', (msg: ({ success: true } & BeatAnalysisResult) | { success: false; error: string }) => {
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    if (msg.success) p.resolve(msg)
    else p.reject(new Error(msg.error))
  })

  worker.on('error', (err) => {
    if (_worker === worker) _worker = null
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    p.reject(err)
  })

  worker.on('exit', (code) => {
    if (_worker === worker) _worker = null
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    if (code !== 0) p.reject(new Error(`Beat worker crashed (exit ${code}) — track skipped`))
    // code 0 = already resolved via 'message'
  })

  return worker
}

function ensureWorker(): Worker {
  if (!_worker) _worker = spawnWorker()
  return _worker
}

/**
 * Warm the worker — starts it and pre-loads the ONNX model so the first
 * real analysis call doesn't pay the cold-start cost.
 * Safe to call from main process: no ONNX code runs here.
 */
export function warmModel(): void {
  if (!isModelAvailable()) return
  try { ensureWorker() } catch { /* model not installed */ }
}

/**
 * Analyse beats for one track.
 * Requests are serialised through the single persistent worker.
 */
export function analyzeBeats(filePath: string): Promise<BeatAnalysisResult> {
  if (!isModelAvailable()) {
    throw new Error(`Beat model not found. Place beat_this.onnx in: ${getDefaultModelPath()}`)
  }

  if (_pending) {
    // Belt-and-braces: callers should await sequentially, but protect just in case
    return Promise.reject(new Error('Beat analysis already in progress — await the current call first'))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending = null
      _worker?.terminate(); _worker = null   // hard-kill; next call will restart
      reject(new Error('Beat analysis timed out (>5 min) — track skipped'))
    }, TIMEOUT_MS)

    _pending = { resolve, reject, timer }
    ensureWorker().postMessage({ filePath })
  })
}
