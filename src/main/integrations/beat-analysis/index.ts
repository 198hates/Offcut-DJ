import { fork, type ChildProcess } from 'child_process'
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
 * Persistent child process for ONNX beat analysis.
 *
 * worker_threads share process memory with the parent — a native crash
 * (ONNX abort/SIGSEGV) inside a worker_thread kills the entire Electron
 * app. child_process.fork() creates a fully independent OS process:
 * if ONNX crashes the child, the parent gets a 'close' event, marks
 * the track as failed, and starts a fresh child for the next track.
 * The Electron app is never affected.
 *
 * The model is loaded once when the child starts and stays resident,
 * so repeated analysis calls pay no per-track cold-start cost.
 */

type PendingRequest = {
  resolve: (r: BeatAnalysisResult) => void
  reject:  (e: Error) => void
  timer:   ReturnType<typeof setTimeout>
}

const TIMEOUT_MS  = 5 * 60_000   // 5 min hard cap per track
const WORKER_PATH = join(__dirname, 'beat-analysis-worker.js')

let _child:   ChildProcess | null = null
let _pending: PendingRequest | null = null

function spawnChild(): ChildProcess {
  const child = fork(WORKER_PATH, [], {
    env: { ...process.env, BEAT_MODEL_PATH: getDefaultModelPath() },
    silent: true,   // suppress child stdout/stderr from leaking into app logs
  })

  child.on('message', (msg: ({ success: true } & BeatAnalysisResult) | { success: false; error: string }) => {
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    if (msg.success) p.resolve(msg)
    else p.reject(new Error(msg.error))
  })

  child.on('error', (err) => {
    if (_child === child) _child = null
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    p.reject(err)
  })

  // 'close' fires after stdio streams close — more reliable than 'exit' for fork
  child.on('close', (code, signal) => {
    if (_child === child) _child = null
    const p = _pending; _pending = null
    if (!p) return
    clearTimeout(p.timer)
    if (code !== 0 || signal) {
      p.reject(new Error(
        signal
          ? `Beat process killed by signal ${signal} — track skipped`
          : `Beat process exited with code ${code} — track skipped`
      ))
    }
    // code 0 + no signal = already resolved via 'message'
  })

  return child
}

function ensureChild(): ChildProcess {
  if (!_child) _child = spawnChild()
  return _child
}

/**
 * Warm: start the child process so the first real analysis call
 * doesn't pay the process-launch + model-load cost (~1–2 s).
 */
export function warmModel(): void {
  if (!isModelAvailable()) return
  try { ensureChild() } catch { /* model not installed */ }
}

/**
 * Analyse beats for one track.
 * Requests are serialised: callers must await each call before making the next.
 */
export function analyzeBeats(filePath: string): Promise<BeatAnalysisResult> {
  if (!isModelAvailable()) {
    throw new Error(`Beat model not found. Place beat_this.onnx in: ${getDefaultModelPath()}`)
  }

  if (_pending) {
    return Promise.reject(new Error('Beat analysis already in progress'))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending = null
      _child?.kill('SIGKILL'); _child = null
      reject(new Error('Beat analysis timed out (>5 min) — track skipped'))
    }, TIMEOUT_MS)

    _pending = { resolve, reject, timer }
    ensureChild().send({ filePath })
  })
}
