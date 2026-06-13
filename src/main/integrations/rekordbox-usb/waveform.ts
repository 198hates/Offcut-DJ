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

// 44.1 kHz so the treble band (> 3 kHz) captures the full high end up to ~22 kHz
// — at 22 kHz the highs were starved and the waveform read bass-heavy/blue.
const SAMPLE_RATE = 44_100

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

// Band crossovers, tuned by matching our band means to a real rekordbox export
// (mean error ≈ 6/127 per band over 8 tracks). The low band is intentionally a
// narrow sub-bass/kick band — a wider one captures sustained low-mids and reads
// too blue; basslines belong to "mid", which is how rekordbox treats them.
const LOW_HZ = 40
const HIGH_HZ = 1800

/**
 * Run `samples` through a cascade of biquads (series) and accumulate the
 * per-bucket peak |output| into `out`. Cascading two sections gives a steeper
 * 4th-order rolloff so the bands are well separated (a single 2nd-order section
 * leaks an octave of neighbouring content). One O(N) pass.
 */
function filterPeaks(samples: Float32Array, stages: Biquad[], out: Float32Array): void {
  const total = samples.length
  const spb = total / out.length
  const z1 = new Float64Array(stages.length)
  const z2 = new Float64Array(stages.length)
  for (let i = 0; i < total; i++) {
    let x = samples[i]
    for (let s = 0; s < stages.length; s++) {
      const f = stages[s]
      const y = f.b0 * x + z1[s]
      z1[s] = f.b1 * x - f.a1 * y + z2[s]
      z2[s] = f.b2 * x - f.a2 * y
      x = y
    }
    const a = x < 0 ? -x : x
    const b = Math.min(out.length - 1, Math.floor(i / spb))
    if (a > out[b]) out[b] = a
  }
}

/**
 * Split mono PCM into 3 frequency bands (bass < 200 Hz, mid 200 Hz–2.5 kHz,
 * treble > 2.5 kHz) with steep 4th-order Butterworth crossovers, reduce each to
 * `buckets` per-bucket peaks, and normalise each band to its OWN peak. Real
 * rekordbox exports do this (every band's maxima reach ~127 independently); it's
 * what gives the warm mid/high-forward colour instead of a bass-heavy blue wash.
 * The mono preview is scaled to its own peak.
 */
export function computeWaveformBands(
  samples: Float32Array,
  sampleRate: number,
  buckets: number,
  lowHz = LOW_HZ,
  highHz = HIGH_HZ
): WaveformBands {
  const n = Math.max(1, buckets)
  const peaks = new Float32Array(n)
  const low = new Float32Array(n)
  const mid = new Float32Array(n)
  const high = new Float32Array(n)
  if (samples.length === 0) return { peaks, low, mid, high }

  // Overall mono envelope (peak |sample| per bucket — the outline shows dynamics).
  const spb = samples.length / n
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    const b = Math.min(n - 1, Math.floor(i / spb))
    if (a > peaks[b]) peaks[b] = a
  }

  // 4th-order = two cascaded 2nd-order Butterworth sections; mid is a band-pass
  // built from a high-pass then low-pass cascade (flat passband, steep skirts).
  filterPeaks(samples, [lowpass(lowHz, sampleRate), lowpass(lowHz, sampleRate)], low)
  filterPeaks(samples, [highpass(lowHz, sampleRate), lowpass(highHz, sampleRate)], mid)
  filterPeaks(samples, [highpass(highHz, sampleRate), highpass(highHz, sampleRate)], high)

  scale(peaks, maxOf(peaks))
  scale(low, maxOf(low)) // per-band normalisation (each band → its own peak)
  scale(mid, maxOf(mid))
  scale(high, maxOf(high))
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
