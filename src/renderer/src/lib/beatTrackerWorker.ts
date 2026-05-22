/**
 * beatTrackerWorker.ts — JS/WASM-free beat tracker
 *
 * Algorithm:
 *   1. Spectral flux onset strength  (23 ms hop, 1024-point FFT at 22 kHz)
 *   2. Autocorrelation tempo estimation  (60–200 BPM)
 *   3. DP beat tracker  (Ellis-style, Gaussian transition cost)
 *   4. Bar grouping + downbeat detection
 *
 * Runs entirely in a Web Worker thread — no DOM, no Electron APIs.
 */

import type { BeatgridMarker } from '@shared/types'

// ── Message types ─────────────────────────────────────────────────────────────

export interface BeatTrackerInput {
  samples: Float32Array    // mono, original sample rate
  sampleRate: number
  bpmHint?: number         // optional tag/stored BPM to guide octave correction
}

export type BeatTrackerMessage =
  | { type: 'progress'; pct: number }
  | { type: 'result';  markers: BeatgridMarker[]; detectedBpm: number }
  | { type: 'error';   message: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_SR   = 22050
const FFT_SIZE    = 1024
const HOP_SIZE    = 512          // ~23 ms hop at 22 kHz
const MIN_BPM     = 60
const MAX_BPM     = 200

// ── Bit-reversal permutation for in-place FFT ─────────────────────────────────

function bitReverse(n: number): number[] {
  const bits = Math.round(Math.log2(n))
  const out: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    let rev = 0
    let x   = i
    for (let b = 0; b < bits; b++) { rev = (rev << 1) | (x & 1); x >>= 1 }
    out[i] = rev
  }
  return out
}

const REV1024 = bitReverse(FFT_SIZE)

/** In-place Cooley-Tukey FFT on paired real/imag arrays (must be power-of-2 length). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // Bit-reversal shuffle
  for (let i = 0; i < n; i++) {
    const j = REV1024[i]
    if (j > i) {
      ;[re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]]
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang), wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j],       uIm = im[i + j]
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe
        re[i + j]             = uRe + vRe;  im[i + j]             = uIm + vIm
        re[i + j + len / 2]   = uRe - vRe;  im[i + j + len / 2]   = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

// ── Step 0: Downsample ────────────────────────────────────────────────────────

function downsample(samples: Float32Array, srcSr: number): Float32Array {
  const factor = Math.max(1, Math.floor(srcSr / TARGET_SR))
  if (factor === 1) return samples
  const len = Math.floor(samples.length / factor)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += samples[i * factor + j]
    out[i] = s / factor
  }
  return out
}

// ── Step 1: Spectral flux onset strength ─────────────────────────────────────
// Positive half-wave rectified difference of FFT magnitudes between frames.
// Much more sensitive to transients (kick, snare) than RMS-difference alone.

function spectralFlux(audio: Float32Array): Float32Array {
  const hann = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
  }

  const nFrames = Math.max(1, Math.floor((audio.length - FFT_SIZE) / HOP_SIZE) + 1)
  const odf     = new Float32Array(nFrames)
  const prevMag = new Float32Array(FFT_SIZE / 2 + 1)

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP_SIZE
    const re    = new Float64Array(FFT_SIZE)
    const im    = new Float64Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (audio[start + i] ?? 0) * hann[i]
    }
    fft(re, im)

    let flux = 0
    for (let k = 0; k <= FFT_SIZE / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      flux += Math.max(0, mag - prevMag[k])
      prevMag[k] = mag
    }
    odf[f] = flux
  }

  // Normalise to [0, 1]
  const peak = Math.max(...odf)
  if (peak > 0) for (let i = 0; i < nFrames; i++) odf[i] /= peak

  return odf
}

// ── Step 2: Autocorrelation tempo estimation ──────────────────────────────────

function estimateTempo(odf: Float32Array, hopMs: number, bpmHint?: number): number {
  const minLag = Math.max(1, Math.round(60000 / (MAX_BPM * hopMs)))
  const maxLag = Math.round(60000 / (MIN_BPM * hopMs))

  // Use first 90 s for speed
  const useN = Math.min(odf.length, Math.round(90000 / hopMs))

  let bestLag  = minLag
  let bestCorr = -Infinity

  for (let lag = minLag; lag <= maxLag && lag < useN; lag++) {
    let corr = 0
    for (let i = 0; i < useN - lag; i++) corr += odf[i] * odf[i + lag]
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag }
  }

  let bpm = 60000 / (bestLag * hopMs)

  // Octave / double-tempo correction to keep result in 80–160 BPM range
  if (bpm < 80 && bpm * 2 <= MAX_BPM) bpm *= 2
  if (bpm > 160 && bpm / 2 >= MIN_BPM) bpm /= 2

  // If a hint is provided, snap to it if within 15%
  if (bpmHint) {
    for (const ratio of [1, 2, 0.5]) {
      const candidate = bpm * ratio
      if (Math.abs(candidate - bpmHint) / bpmHint < 0.15) { bpm = candidate; break }
    }
  }

  return Math.max(MIN_BPM, Math.min(MAX_BPM, bpm))
}

// ── Step 3: DP beat tracker ───────────────────────────────────────────────────
// For each frame i, the best predecessor j maximises:
//   score[j] + odf[i] × gauss((i - j) / period, σ=0.25)
// We bound the search to ±50% of the expected period (bounded O(n)).

function dpBeatTracker(odf: Float32Array, hopMs: number, bpm: number): number[] {
  const period   = 60000 / bpm / hopMs          // expected beat interval in frames
  const halfWin  = Math.ceil(period * 0.5)      // search window radius
  const sigma    = period * 0.25                // Gaussian σ
  const n        = odf.length

  if (n < period * 2) {
    // Track too short — fall back to uniform grid
    const beats: number[] = []
    for (let t = Math.round(period * 0.1); t < n; t += Math.round(period)) beats.push(t)
    return beats
  }

  const score   = new Float64Array(n).fill(-Infinity)
  const backptr = new Int32Array(n).fill(-1)

  // Seed: any frame can start a beat sequence with its own ODF value
  for (let i = 0; i < n; i++) score[i] = odf[i]

  // Forward DP
  const idealPrev = Math.round(period)
  for (let i = idealPrev; i < n; i++) {
    const jMin = Math.max(0, i - idealPrev - halfWin)
    const jMax = Math.min(i - 1, i - idealPrev + halfWin)

    let bestS = -Infinity
    let bestJ = -1

    for (let j = jMin; j <= jMax; j++) {
      if (score[j] <= -Infinity) continue
      const dev = (i - j - idealPrev) / sigma
      const g   = Math.exp(-0.5 * dev * dev)
      const s   = score[j] + odf[i] * (1 + g)  // onset + transition bonus
      if (s > bestS) { bestS = s; bestJ = j }
    }

    if (bestJ >= 0) {
      score[i]   = bestS
      backptr[i] = bestJ
    }
  }

  // Best endpoint: highest score in last 10% of track (avoid trailing silence)
  const tail = Math.max(0, Math.floor(n * 0.9))
  let endIdx = tail
  for (let i = tail + 1; i < n; i++) {
    if (score[i] > score[endIdx]) endIdx = i
  }

  // Backtrack
  const beatFrames: number[] = []
  let idx    = endIdx
  let safety = 0
  while (idx >= 0 && safety++ < n) {
    beatFrames.push(idx)
    const p = backptr[idx]
    if (p < 0 || p >= idx) break
    idx = p
  }

  return beatFrames.reverse()
}

// ── Step 4: Build BeatgridMarkers ─────────────────────────────────────────────

function buildMarkers(
  beatFrames: number[],
  odf: Float32Array,
  hopMs: number,
  bpm: number
): BeatgridMarker[] {
  if (beatFrames.length === 0) return []

  // Determine downbeat phase: which of the 4-beat positions best aligns
  // with the strongest onsets (crude low-frequency emphasis via frame sum).
  // We score each of the 4 possible phases.
  const phaseScore = [0, 0, 0, 0]
  for (let i = 0; i < beatFrames.length; i++) {
    phaseScore[i % 4] += odf[beatFrames[i]] ?? 0
  }
  const downbeatPhase = phaseScore.indexOf(Math.max(...phaseScore))

  return beatFrames.map((f, i) => {
    const posMs = f * hopMs
    const nextF = beatFrames[i + 1]
    const intervalMs = nextF != null ? (nextF - f) * hopMs : 60000 / bpm
    const localBpm   = intervalMs > 0 ? 60000 / intervalMs : bpm

    return {
      positionMs: Math.round(posMs),
      bpm:        Math.round(localBpm * 10) / 10,
      isDownbeat: (i - downbeatPhase + beatFrames.length * 4) % 4 === 0,
      confidence: Math.min(1, (odf[f] ?? 0) * 2)  // odf is normalised [0,1]
    }
  })
}

// ── Worker entry point ────────────────────────────────────────────────────────

self.onmessage = ({ data }: MessageEvent<BeatTrackerInput>) => {
  try {
    const { samples, sampleRate, bpmHint } = data
    const post = (msg: BeatTrackerMessage) => self.postMessage(msg)

    post({ type: 'progress', pct: 0.05 })

    // 0. Downsample
    const audio  = downsample(samples, sampleRate)
    const hopMs  = (HOP_SIZE / TARGET_SR) * 1000   // ~23.2 ms

    post({ type: 'progress', pct: 0.20 })

    // 1. Onset strength
    const odf = spectralFlux(audio)

    post({ type: 'progress', pct: 0.45 })

    // 2. Tempo
    const detectedBpm = estimateTempo(odf, hopMs, bpmHint)

    post({ type: 'progress', pct: 0.55 })

    // 3. DP beat tracker
    const beatFrames = dpBeatTracker(odf, hopMs, detectedBpm)

    post({ type: 'progress', pct: 0.85 })

    // 4. Markers
    const markers = buildMarkers(beatFrames, odf, hopMs, detectedBpm)

    post({ type: 'progress', pct: 1.0 })
    post({ type: 'result', markers, detectedBpm })

  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) } satisfies BeatTrackerMessage)
  }
}
