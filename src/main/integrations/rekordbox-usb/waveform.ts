// Spectral waveform analysis for Rekordbox ANLZ colour-waveform export.
//
// Decodes the audio to mono PCM (ffmpeg) and splits it into three frequency
// bands — bass (< ~300 Hz), mid (~300 Hz–3 kHz), treble (> ~3 kHz) — with real
// 2nd-order Butterworth biquad filters applied to the RAW signal, then takes the
// per-bucket peak of each band. (Filtering the raw signal — rather than the
// rectified envelope the playback engine uses for its display — gives true
// frequency separation: a pure treble tone lands entirely in the treble band.)
// The three bands share one normalisation scale so their relative magnitudes
// survive; that ratio is what the CDJ renders as colour (bass=red, mid=green,
// treble=blue), instead of a flat white block — and no track has to be
// re-analysed on the player.

import { decodeAudioToPcm } from '../beat-analysis/audio-decode'

/** Per-bucket amplitude envelopes, each value 0..1. All arrays share `length`. */
export interface WaveformBands {
  /** Overall amplitude (max |sample| per bucket) — drives the mono preview. */
  peaks: Float32Array
  /** Bass band (< ~300 Hz). */
  low: Float32Array
  /** Mid band (~300 Hz – 3 kHz). */
  mid: Float32Array
  /** Treble band (> ~3 kHz). */
  high: Float32Array
}

// 22.05 kHz mono is plenty for a waveform display and keeps decode + memory
// cheap; the 3 kHz treble split still captures up to Nyquist (~11 kHz).
const SAMPLE_RATE = 22_050

function maxOf(v: Float32Array): number {
  let max = 0
  for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i]
  return max
}

function scale(v: Float32Array, by: number): void {
  if (by > 0) for (let i = 0; i < v.length; i++) v[i] /= by
}

// ── Biquad filtering (RBJ cookbook, normalised to a0) ─────────────────────────

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

function lowpass(fc: number, sr: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * fc) / sr
  const cw = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return { b0: ((1 - cw) / 2) / a0, b1: (1 - cw) / a0, b2: ((1 - cw) / 2) / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 }
}

function highpass(fc: number, sr: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * fc) / sr
  const cw = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return { b0: ((1 + cw) / 2) / a0, b1: (-(1 + cw)) / a0, b2: ((1 + cw) / 2) / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 }
}

function bandpass(fc: number, sr: number, q: number): Biquad {
  const w = (2 * Math.PI * fc) / sr
  const cw = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 }
}

/**
 * Filter `samples` through `f` and accumulate the per-bucket peak |output| into
 * `out` (length = bucket count). Runs the Transposed Direct Form II difference
 * equation with carried state — one O(N) pass.
 */
function filterPeaks(samples: Float32Array, f: Biquad, out: Float32Array): void {
  const total = samples.length
  const spb = total / out.length
  let z1 = 0
  let z2 = 0
  for (let i = 0; i < total; i++) {
    const x = samples[i]
    const y = f.b0 * x + z1
    z1 = f.b1 * x - f.a1 * y + z2
    z2 = f.b2 * x - f.a2 * y
    const a = y < 0 ? -y : y
    const b = Math.min(out.length - 1, Math.floor(i / spb))
    if (a > out[b]) out[b] = a
  }
}

/**
 * Split mono PCM into 3 frequency bands with Butterworth biquads and reduce each
 * to `buckets` per-bucket peaks. Bands share one normalisation scale so colour
 * ratios are preserved; the mono preview is scaled to its own peak.
 */
export function computeWaveformBands(samples: Float32Array, sampleRate: number, buckets: number): WaveformBands {
  const n = Math.max(1, buckets)
  const peaks = new Float32Array(n)
  const low = new Float32Array(n)
  const mid = new Float32Array(n)
  const high = new Float32Array(n)
  if (samples.length === 0) return { peaks, low, mid, high }

  // Overall mono envelope (peak |sample| per bucket).
  const spb = samples.length / n
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    const b = Math.min(n - 1, Math.floor(i / spb))
    if (a > peaks[b]) peaks[b] = a
  }

  // bass < 300 Hz · mid ≈ 300 Hz–3 kHz (broad bandpass) · treble > 3 kHz.
  const midCentre = Math.sqrt(300 * 3000) // geometric centre ≈ 949 Hz
  filterPeaks(samples, lowpass(300, sampleRate), low)
  filterPeaks(samples, bandpass(midCentre, sampleRate, midCentre / 2700), mid)
  filterPeaks(samples, highpass(3000, sampleRate), high)

  scale(peaks, maxOf(peaks))
  const bandMax = Math.max(maxOf(low), maxOf(mid), maxOf(high))
  scale(low, bandMax)
  scale(mid, bandMax)
  scale(high, bandMax)
  return { peaks, low, mid, high }
}

/**
 * Decode `filePath` and produce 3-band waveform envelopes at the ANLZ "detail"
 * resolution (≈150 columns/sec). Returns `null` if decoding fails so the caller
 * can fall back to a flat waveform rather than aborting the whole export.
 */
export async function analyzeWaveform(filePath: string, durationSec: number): Promise<WaveformBands | null> {
  try {
    const samples = await decodeAudioToPcm(filePath, SAMPLE_RATE)
    const seconds = durationSec > 0 ? durationSec : samples.length / SAMPLE_RATE
    const buckets = Math.max(1, Math.round(seconds * 150))
    return computeWaveformBands(samples, SAMPLE_RATE, buckets)
  } catch {
    return null
  }
}
