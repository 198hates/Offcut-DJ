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
  const nMels = MEL_CONFIG.nMels

  // Chunked inference, matching upstream split_predict_aggregate: the model is
  // trained on 1500-frame (30 s) excerpts, so long tracks are processed in
  // 1500-frame windows with a 6-frame border discarded on each side
  // (fill-once = upstream's keep_first). Feeding a whole track as one tensor
  // is out-of-distribution and blows up attention memory on long files.
  const CHUNK = 1500
  const BORDER = 6
  const STRIDE = CHUNK - 2 * BORDER

  const logBeat     = new Float32Array(numFrames)
  const logDownbeat = new Float32Array(numFrames)
  const written     = new Uint8Array(numFrames)

  const chunkBuf = new Float32Array(CHUNK * nMels)
  try {
    for (let start = -BORDER; start < numFrames; start += STRIDE) {
      chunkBuf.fill(0)
      const from = Math.max(0, start)
      const to   = Math.min(numFrames, start + CHUNK)
      chunkBuf.set(
        spectrogramData.subarray(from * nMels, to * nMels),
        (from - start) * nMels
      )

      const tensor = new ort.Tensor('float32', chunkBuf, [1, CHUNK, nMels])
      const results = await session.run({ [INPUT_NAME]: tensor })
      const beatOut     = results[BEAT_OUT].data     as Float32Array
      const downbeatOut = results[DOWNBEAT_OUT].data as Float32Array

      const validFrom = Math.max(0, start + BORDER)
      const validTo   = Math.min(numFrames, start + CHUNK - BORDER)
      for (let g = validFrom; g < validTo; g++) {
        if (!written[g]) {
          logBeat[g]     = beatOut[g - start]
          logDownbeat[g] = downbeatOut[g - start]
          written[g] = 1
        }
      }
      if (start + CHUNK >= numFrames + BORDER) break
    }
  } catch (err) {
    _session = null   // force re-init on next call in case the session is corrupted
    throw err
  }

  // Model outputs raw LOGITS (the export wraps the bare BeatThis module) —
  // squash with sigmoid so thresholds and stored confidences are true
  // probabilities in [0, 1]. (exp() of a +5 logit was 148, not 0.99.)
  const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))
  const beatAct     = logBeat.map(sigmoid)
  const downbeatAct = logDownbeat.map(sigmoid)

  const beatFrames     = peakPick(beatAct,     BEAT_THRESHOLD,     PEAK_WINDOW_FRAMES)
  const downbeatFrames = peakPick(downbeatAct, DOWNBEAT_THRESHOLD, PEAK_WINDOW_FRAMES)

  const hopSec = MEL_CONFIG.hopLength / MEL_CONFIG.sampleRate

  // Sub-frame refinement: a 3-point parabolic fit around each activation peak
  // recovers beat positions well below the 20 ms hop, which otherwise puts
  // ±10 ms of jitter on every beat and quantizes the per-beat BPM.
  const refine = (frame: number, act: Float32Array): number => {
    if (frame <= 0 || frame >= act.length - 1) return frame
    const a = act[frame - 1], b = act[frame], c = act[frame + 1]
    const denom = a - 2 * b + c
    if (denom >= 0) return frame // not a strict maximum
    const d = (0.5 * (a - c)) / denom
    return frame + Math.max(-0.5, Math.min(0.5, d))
  }
  const refined = beatFrames.map((f) => refine(f, beatAct))

  // A beat is a downbeat if a downbeat-head peak lands within ±2 frames —
  // the two heads don't always peak on the identical frame.
  const isDownbeatAt = (frame: number): boolean =>
    downbeatFrames.some((d) => Math.abs(d - frame) <= 2)

  // Compute BPM at each beat from the refined inter-beat interval
  const markers: BeatgridMarker[] = beatFrames.map((frame, i) => {
    const pos = refined[i]
    const next = i + 1 < refined.length ? refined[i + 1] : pos + 0.5 / hopSec
    const intervalMs = (next - pos) * hopSec * 1000
    const bpm = intervalMs > 0 ? 60000 / intervalMs : 120

    return {
      positionMs: pos * hopSec * 1000,
      bpm: Math.round(bpm * 100) / 100,
      isDownbeat: isDownbeatAt(frame),
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
