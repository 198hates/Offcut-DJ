import * as ort from 'onnxruntime-node'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { MEL_CONFIG } from './mel-spectrogram'
import type { BeatgridMarker } from '../../../shared/types'

// The model expects input named 'input' and outputs named 'beat' and 'downbeat'.
// These names are set by the Python export script (scripts/export-beat-this.py).
const INPUT_NAME   = 'input'
const BEAT_OUT     = 'beat'
const DOWNBEAT_OUT = 'downbeat'

// Peak picking parameters
const BEAT_THRESHOLD      = 0.3   // minimum activation to be considered a beat
const DOWNBEAT_THRESHOLD  = 0.3
const PEAK_WINDOW_FRAMES  = 6     // local maximum within ±6 frames (~120ms)

let _session: ort.InferenceSession | null = null
let _runCount = 0

export function getDefaultModelPath(): string {
  // Packaged builds ship the model under Resources/models; a user-supplied copy
  // in userData/models still wins (lets people swap checkpoints without a rebuild).
  const userCopy = join(app.getPath('userData'), 'models', 'beat_this.onnx')
  if (existsSync(userCopy)) return userCopy
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'models', 'beat_this.onnx')
    if (existsSync(bundled)) return bundled
  }
  return userCopy
}

export function isModelAvailable(modelPath?: string): boolean {
  return existsSync(modelPath ?? getDefaultModelPath())
}

async function getSession(modelPath?: string): Promise<ort.InferenceSession> {
  if (_session) return _session
  const mp = modelPath ?? getDefaultModelPath()
  if (!existsSync(mp)) throw new Error(`Beat This! model not found at: ${mp}`)

  // CPU-only: CoreML can crash the main process on large/variable-length transformer inputs.
  // ONNX CPU provider uses SIMD and is fast enough for offline batch analysis.
  _session = await ort.InferenceSession.create(mp, { executionProviders: ['cpu'] })
  return _session
}

/** Warm the model into memory — call on app start so first analysis isn't slow */
export async function warmModel(modelPath?: string): Promise<void> {
  try { await getSession(modelPath) } catch { /* model not installed yet */ }
}

function peakPick(
  activation: Float32Array | number[],
  threshold: number,
  windowFrames: number
): number[] {
  const peaks: number[] = []
  for (let i = windowFrames; i < activation.length - windowFrames; i++) {
    if (activation[i] < threshold) continue
    let isPeak = true
    for (let j = i - windowFrames; j <= i + windowFrames; j++) {
      if (j !== i && activation[j] >= activation[i]) { isPeak = false; break }
    }
    if (isPeak) peaks.push(i)
  }
  return peaks
}

/**
 * Run beat analysis on a precomputed mel spectrogram.
 * Returns a list of BeatgridMarkers sorted by position.
 */
export async function runBeatAnalysis(
  spectrogramData: Float32Array,
  numFrames: number,
  modelPath?: string
): Promise<BeatgridMarker[]> {
  const session = await getSession(modelPath)

  let results: Awaited<ReturnType<typeof session.run>>
  try {
    // Input tensor: [1, numFrames, nMels]
    const tensor = new ort.Tensor('float32', spectrogramData, [1, numFrames, MEL_CONFIG.nMels])
    results = await session.run({ [INPUT_NAME]: tensor })
  } catch (err) {
    _session = null   // force re-init on next call in case the session is corrupted
    throw err
  }

  // Model outputs log-probabilities — convert to probabilities before peak picking
  const logBeat     = results[BEAT_OUT].data     as Float32Array
  const logDownbeat = results[DOWNBEAT_OUT].data as Float32Array
  const beatAct     = logBeat.map(Math.exp)
  const downbeatAct = logDownbeat.map(Math.exp)

  const beatFrames     = peakPick(beatAct,     BEAT_THRESHOLD,     PEAK_WINDOW_FRAMES)
  const downbeatFrames = new Set(peakPick(downbeatAct, DOWNBEAT_THRESHOLD, PEAK_WINDOW_FRAMES))

  const hopSec = MEL_CONFIG.hopLength / MEL_CONFIG.sampleRate

  // Compute BPM at each beat from inter-beat interval to next beat
  const markers: BeatgridMarker[] = beatFrames.map((frame, i) => {
    const posMs = frame * hopSec * 1000
    const nextFrame = beatFrames[i + 1] ?? (frame + Math.round(0.5 / hopSec))
    const intervalMs = (nextFrame - frame) * hopSec * 1000
    const bpm = intervalMs > 0 ? 60000 / intervalMs : 120

    return {
      positionMs: posMs,
      bpm: Math.round(bpm * 10) / 10,
      isDownbeat: downbeatFrames.has(frame),
      confidence: Math.round(beatAct[frame] * 1000) / 1000,
    }
  })

  const sorted = markers.sort((a, b) => a.positionMs - b.positionMs)

  // Periodically reset the session to flush ONNX internal allocations.
  // Every 15 tracks is a reasonable compromise between memory and reload overhead.
  _runCount++
  if (_runCount % 15 === 0) _session = null

  return sorted
}
