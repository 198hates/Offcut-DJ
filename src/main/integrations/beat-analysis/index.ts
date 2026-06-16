import { fork, type ChildProcess } from 'child_process'
import { cpus } from 'os'
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

// Pool of independent model processes so several tracks analyse in parallel.
// Each child loads its own copy of the ONNX model, so keep the pool small.
const POOL_SIZE = Math.max(1, Math.min(3, (cpus().length || 4) - 1))

interface Slot { child: ChildProcess | null; pending: PendingRequest | null }
interface Job { filePath: string; resolve: (r: BeatAnalysisResult) => void; reject: (e: Error) => void }

const _pool: Slot[] = []
const _queue: Job[] = []

function spawnInto(slot: Slot): void {
  const child = fork(WORKER_PATH, [], {
    env: { ...process.env, BEAT_MODEL_PATH: getDefaultModelPath() },
    silent: true,   // suppress child stdout/stderr from leaking into app logs
  })
  slot.child = child

  child.on('message', (msg: ({ success: true } & BeatAnalysisResult) | { success: false; error: string }) => {
    const p = slot.pending; slot.pending = null
    if (p) {
      clearTimeout(p.timer)
      if (msg.success) p.resolve(msg)
      else p.reject(new Error(msg.error))
    }
    pump()
  })

  // A child runs many tracks; a 'close'/'error' therefore means it crashed.
  // Reject the in-flight job, drop the slot's child (lazily respawned by pump
  // when there's more work) — so a single ONNX crash never takes the app down.
  const die = (err: Error): void => {
    if (slot.child !== child) return
    slot.child = null
    const p = slot.pending; slot.pending = null
    if (p) { clearTimeout(p.timer); p.reject(err) }
    pump()
  }
  child.on('error', die)
  child.on('close', (code, signal) =>
    die(new Error(signal
      ? `Beat process killed by signal ${signal} — track skipped`
      : `Beat process exited with code ${code} — track skipped`)))
}

function ensurePool(): void {
  if (_pool.length === 0) for (let i = 0; i < POOL_SIZE; i++) _pool.push({ child: null, pending: null })
}

/** Assign queued jobs to free slots (spawning a child on demand). */
function pump(): void {
  for (const slot of _pool) {
    if (slot.pending || _queue.length === 0) continue
    if (!slot.child) spawnInto(slot)
    const job = _queue.shift()!
    const timer = setTimeout(() => {
      slot.pending = null
      try { slot.child?.kill('SIGKILL') } catch { /* already gone */ }
      slot.child = null
      job.reject(new Error('Beat analysis timed out (>5 min) — track skipped'))
    }, TIMEOUT_MS)
    slot.pending = { resolve: job.resolve, reject: job.reject, timer }
    slot.child!.send({ filePath: job.filePath })
  }
}

/**
 * Warm: pre-start one pool process so the first analysis call doesn't pay the
 * launch + model-load cost. The rest of the pool spawns lazily under load, so
 * idle startup only carries one model in memory.
 */
export function warmModel(): void {
  if (!isModelAvailable()) return
  try { ensurePool(); if (_pool[0] && !_pool[0].child) spawnInto(_pool[0]) } catch { /* model not installed */ }
}

/** Analyse beats for one track. Concurrent calls run across the pool. */
export function analyzeBeats(filePath: string): Promise<BeatAnalysisResult> {
  if (!isModelAvailable()) {
    throw new Error(`Beat model not found. Place beat_this.onnx in: ${getDefaultModelPath()}`)
  }
  return new Promise<BeatAnalysisResult>((resolve, reject) => {
    _queue.push({ filePath, resolve, reject })
    ensurePool()
    pump()
  })
}
