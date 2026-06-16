/**
 * phraseDetect.ts — DJ-oriented song-structure detection, pure DSP, no model.
 *
 * Replaces the (Apple-Silicon-hostile) all-in-one/NATTEN sidecar with a local,
 * dependency-free detector. DJs care about ENERGY structure — intro, build,
 * drop, breakdown, outro — not musicological verse/chorus, so we segment by the
 * broadband + bass energy envelope and label by level, position and dynamics.
 *
 * Pure core operates on a Float32Array (node-testable); an AudioBuffer wrapper
 * is provided for the renderer. Output is the same PhraseSegment[] the rest of
 * the app already consumes, so the overlay / persistence are unchanged.
 */

import type { PhraseLabel, PhraseSegment } from '@shared/types'

const FRAME_SEC = 0.5
const HI = 0.55   // broadband energy → "loud"
const HIB = 0.45  // bass energy → kick/bass present (distinguishes drop from build)
const LO = 0.33   // broadband energy → "quiet"
const MIN_SEG_MS = 6000

function frameRms(x: Float32Array, hop: number): number[] {
  const out: number[] = []
  for (let s = 0; s + hop <= x.length; s += hop) {
    let sum = 0
    for (let i = s; i < s + hop; i++) sum += x[i] * x[i]
    out.push(Math.sqrt(sum / hop))
  }
  return out
}

/** One-pole low-pass — cheap bass-energy isolation (no FFT needed). */
function lowpass(x: Float32Array, fs: number, fc: number): Float32Array {
  const dt = 1 / fs
  const rc = 1 / (2 * Math.PI * fc)
  const a = dt / (rc + dt)
  const y = new Float32Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) { prev += a * (x[i] - prev); y[i] = prev }
  return y
}

function smooth(a: number[], w: number): number[] {
  const out = a.slice()
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0
    for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) { s += a[j]; c++ }
    out[i] = s / c
  }
  return out
}

/** Normalise to 0–1 against the 95th percentile (robust to transient peaks). */
function norm(a: number[]): number[] {
  if (!a.length) return a
  const sorted = [...a].sort((x, y) => x - y)
  const hi = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 1
  return a.map((v) => Math.min(1, v / (hi || 1)))
}

function quantizeMs(ms: number, bpm: number | null | undefined, firstBeatMs: number): number {
  if (!bpm || bpm <= 0) return ms
  const barMs = (60 / bpm) * 4 * 1000
  return Math.max(0, Math.round((ms - firstBeatMs) / barMs) * barMs + firstBeatMs)
}

/**
 * Detect phrase segments from a mono signal. `bpm`/`firstBeatMs` (optional)
 * quantise boundaries to bar lines.
 */
export function detectPhrasesFromMono(
  mono: Float32Array,
  fs: number,
  bpm?: number | null,
  firstBeatMs = 0
): PhraseSegment[] {
  const hop = Math.round(FRAME_SEC * fs)
  if (mono.length < hop * 4) return []

  const E = norm(smooth(frameRms(mono, hop), 2))
  const B = norm(smooth(frameRms(lowpass(mono, fs, 160), hop), 2))
  const n = E.length

  // Base classes.
  type Tmp = PhraseLabel | 'low' | 'mid'
  const lab: Tmp[] = new Array(n)
  for (let i = 0; i < n; i++) {
    if (E[i] >= HI && B[i] >= HIB) lab[i] = 'drop'
    else if (E[i] < LO) lab[i] = 'low'
    else lab[i] = 'mid'
  }

  const firstDrop = lab.indexOf('drop')
  let lastDrop = -1
  for (let i = n - 1; i >= 0; i--) if (lab[i] === 'drop') { lastDrop = i; break }

  // Position/level → DJ labels.
  for (let i = 0; i < n; i++) {
    if (lab[i] === 'drop') continue
    if (firstDrop === -1) { lab[i] = lab[i] === 'low' ? 'intro' : 'verse'; continue }
    if (i < firstDrop) lab[i] = lab[i] === 'low' ? 'intro' : 'verse'
    else if (i > lastDrop) lab[i] = 'outro'
    else lab[i] = lab[i] === 'low' ? 'breakdown' : 'verse'
  }

  // Buildup: a rising, bass-light ramp of up to 8 frames before a drop onset.
  for (let i = 1; i < n; i++) {
    if (lab[i] === 'drop' && lab[i - 1] !== 'drop') {
      let j = i - 1, count = 0
      while (j >= 0 && lab[j] !== 'drop' && count < 8 && E[j] <= (E[j + 1] ?? 1) + 0.02 && B[j] < HIB) {
        lab[j] = 'buildup'; j--; count++
      }
    }
  }

  const finalLab = lab.map((l) => (l === 'low' ? 'breakdown' : l === 'mid' ? 'verse' : l)) as PhraseLabel[]

  // Contiguous runs → segments.
  const raw: PhraseSegment[] = []
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || finalLab[i] !== finalLab[start]) {
      raw.push({ label: finalLab[start], startMs: start * FRAME_SEC * 1000, endMs: i * FRAME_SEC * 1000, confidence: 0.6 })
      start = i
    }
  }

  // Absorb sub-minimum segments into the previous one, then bar-quantise.
  const merged: PhraseSegment[] = []
  for (const s of raw) {
    if (merged.length && s.endMs - s.startMs < MIN_SEG_MS) merged[merged.length - 1].endMs = s.endMs
    else merged.push({ ...s })
  }
  for (let i = 0; i < merged.length; i++) {
    merged[i].startMs = i === 0 ? 0 : quantizeMs(merged[i].startMs, bpm, firstBeatMs)
    if (i > 0) merged[i - 1].endMs = merged[i].startMs
  }
  return merged.filter((s) => s.endMs > s.startMs)
}

function bufToMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0)
  const a = buf.getChannelData(0), b = buf.getChannelData(1)
  const out = new Float32Array(buf.length)
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (a[i] + b[i])
  return out
}

/** Renderer wrapper — detect phrases from a decoded buffer. */
export function detectPhrases(buffer: AudioBuffer, bpm?: number | null, firstBeatMs = 0): PhraseSegment[] {
  return detectPhrasesFromMono(bufToMono(buffer), buffer.sampleRate, bpm, firstBeatMs)
}
