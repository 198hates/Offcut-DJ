// Runs in a Web Worker thread — no DOM or Electron APIs available here.

export interface AnalyzerInput {
  samples: Float32Array   // mono, original sample rate
  sampleRate: number
  /** Real downbeat positions (ms) from the analysed beatgrid, if available —
   *  used to anchor structural cues to true bars instead of a re-derived grid. */
  bars?: number[]
}

export interface SuggestedCue {
  positionMs: number
  label: string
  color: string
}

export interface AnalyzerResult {
  bpm: number | null
  key: string | null      // Camelot notation e.g. "8B"
  energy: number | null   // 1–10 perceived intensity score
  danceability: number | null  // 0–1
  mood: number | null     // −1.0 (dark/tense) → +1.0 (bright/euphoric)
  offsetMs: number | null // first-beat offset from t=0 (ms) — null if BPM unavailable
  suggestedCues: SuggestedCue[]
}

self.onmessage = (e: MessageEvent<AnalyzerInput>) => {
  const { samples, sampleRate, bars } = e.data
  const bpm          = detectBPM(samples, sampleRate)
  const key          = detectKey(samples, sampleRate)
  const energy       = detectEnergy(samples, sampleRate)
  const danceability = detectDanceability(samples, sampleRate, bpm)
  const mood         = detectMood(samples, sampleRate, key)
  const offsetMs     = bpm != null ? detectBeatPhase(samples, sampleRate, bpm) : null
  // Cues need a bar grid: real downbeats if supplied, else the crude BPM/phase one.
  const haveGrid = (bars != null && bars.length >= 8) || (bpm != null && offsetMs != null)
  const suggestedCues = haveGrid
    ? detectStructuralCues(samples, sampleRate, bpm ?? 0, offsetMs ?? 0, bars)
    : []
  self.postMessage({ bpm, key, energy, danceability, mood, offsetMs, suggestedCues } satisfies AnalyzerResult)
}

// ── BPM via onset-strength autocorrelation ────────────────────────────────────

function detectBPM(samples: Float32Array, sampleRate: number): number | null {
  // Work at ~4 kHz for speed (DJ music has beat energy in bass, easy to track at low rate)
  const TARGET = 4000
  const factor = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual = sampleRate / factor

  // Downsample by averaging blocks (simple anti-aliasing)
  const len = Math.floor(samples.length / factor)
  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += Math.abs(samples[i * factor + j])
    down[i] = s / factor
  }

  // RMS energy in 20 ms windows, 10 ms hop
  const winN = Math.max(1, Math.floor(actual * 0.02))
  const hopN = Math.max(1, Math.floor(winN / 2))
  const nFrames = Math.floor((len - winN) / hopN)
  if (nFrames < 10) return null

  const energy = new Float32Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    const s = i * hopN
    let e = 0
    for (let j = s; j < s + winN; j++) e += down[j] * down[j]
    energy[i] = Math.sqrt(e / winN)
  }

  // Onset strength = positive first difference
  const onset = new Float32Array(nFrames)
  for (let i = 1; i < nFrames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1])

  // Autocorrelation — lags covering 60–200 BPM
  const hopSec = hopN / actual
  const minLag = Math.max(1, Math.floor(60 / (200 * hopSec)))
  const maxLag = Math.ceil(60 / (60 * hopSec))

  // Use first 90 s max for speed
  const useN = Math.min(onset.length, Math.floor(90 / hopSec))

  // Full correlation curve so the peak can be refined to a fractional lag —
  // integer lags at a ~10 ms hop give ~1.5% BPM error at 174 BPM, which
  // drifts a constant grid audibly off the beat within minutes.
  const corrs = new Float32Array(maxLag + 1)
  let bestLag = 0
  let bestCorr = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < useN - lag; i++) corr += onset[i] * onset[i + lag]
    corrs[lag] = corr
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag }
  }

  if (bestLag === 0) return null

  // 3-point parabolic interpolation around the autocorrelation peak.
  let lag = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const a = corrs[bestLag - 1], b = corrs[bestLag], c = corrs[bestLag + 1]
    const denom = a - 2 * b + c
    if (denom < 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom))
  }

  let bestBPM = 60 / (lag * hopSec)

  // Fold into the canonical 80–160 range — only when actually OUTSIDE it
  // (a track at exactly 80 or 160 BPM used to get folded to its octave).
  if (bestBPM > 160 && bestBPM / 2 >= 80) bestBPM /= 2
  else if (bestBPM < 80 && bestBPM * 2 <= 160) bestBPM *= 2

  return Math.round(bestBPM * 10) / 10
}

// ── Key via FFT chromagram + Krumhansl-Schmuckler profiles ───────────────────

// Krumhansl-Kessler profiles (major and minor)
const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

// Camelot notation for each (root, mode) pair
// root 0=C, 1=C#, 2=D … 11=B
const CAMELOT_MAJ = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B']
const CAMELOT_MIN = ['5A','12A','7A','2A','9A','4A','11A','6A','1A','8A','3A','10A']

function detectKey(samples: Float32Array, sampleRate: number): string | null {
  // Work at 22050 Hz
  const TARGET = 22050
  const factor = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual = sampleRate / factor
  const len = Math.floor(samples.length / factor)

  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += samples[i * factor + j]
    down[i] = s / factor
  }

  // FFT frame size 4096, hop 2048 — process first 60 seconds
  const FFT = 4096
  const HOP = 2048
  const maxFrames = Math.min(Math.floor((len - FFT) / HOP), Math.floor(60 * actual / HOP))
  if (maxFrames < 1) return null

  const chroma = new Float64Array(12)

  // Hann window coefficients
  const hann = new Float32Array(FFT)
  for (let i = 0; i < FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1))

  for (let frame = 0; frame < maxFrames; frame++) {
    const start = frame * HOP
    const re = new Float64Array(FFT)
    const im = new Float64Array(FFT)
    for (let i = 0; i < FFT; i++) re[i] = (down[start + i] ?? 0) * hann[i]

    fft(re, im)

    // Map frequency bins to pitch classes, weight by magnitude
    for (let bin = 1; bin < FFT / 2; bin++) {
      const freq = bin * actual / FFT
      if (freq < 65 || freq > 2100) continue   // ~C2 to C7
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin])
      // Convert frequency to fractional MIDI note → pitch class
      const midi = 12 * Math.log2(freq / 440) + 69
      const pc = ((Math.round(midi) % 12) + 12) % 12
      chroma[pc] += mag
    }
  }

  // Normalize
  const maxC = Math.max(...chroma)
  if (maxC === 0) return null
  for (let i = 0; i < 12; i++) chroma[i] /= maxC

  // Pearson correlation against all 24 key templates
  let bestCorr = -Infinity
  let bestRoot = 0
  let bestMode = 'major'

  for (let root = 0; root < 12; root++) {
    for (const [mode, prof] of [['major', KS_MAJ], ['minor', KS_MIN]] as const) {
      const profArr = prof as number[]
      const pMean = profArr.reduce((a, b) => a + b, 0) / 12
      let cMean = 0
      for (let i = 0; i < 12; i++) cMean += chroma[(i + root) % 12]
      cMean /= 12

      let num = 0, dA = 0, dB = 0
      for (let i = 0; i < 12; i++) {
        const a = chroma[(i + root) % 12] - cMean
        const b = profArr[i] - pMean
        num += a * b; dA += a * a; dB += b * b
      }
      const corr = num / (Math.sqrt(dA * dB) || 1)

      if (corr > bestCorr) { bestCorr = corr; bestRoot = root; bestMode = mode }
    }
  }

  return bestMode === 'major' ? CAMELOT_MAJ[bestRoot] : CAMELOT_MIN[bestRoot]
}

// ── Beat phase detection ──────────────────────────────────────────────────────
// Given a known BPM, finds the time offset (ms) of the first beat from t=0
// by scoring every possible phase against the onset-strength envelope.
// Uses the same 4 kHz / 10 ms hop pipeline as detectBPM so onset quality is
// consistent. Analyses the first 60 s (enough beats to lock in cleanly).

function detectBeatPhase(samples: Float32Array, sampleRate: number, bpm: number): number {
  if (bpm <= 0) return 0

  const TARGET = 4000
  const factor = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual = sampleRate / factor

  // Cap at 60 s for speed
  const maxSrc = Math.min(samples.length, sampleRate * 60)
  const len = Math.floor(maxSrc / factor)

  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += Math.abs(samples[i * factor + j])
    down[i] = s / factor
  }

  // RMS energy + onset strength (same windows as detectBPM)
  const winN = Math.max(1, Math.floor(actual * 0.02))
  const hopN = Math.max(1, Math.floor(winN / 2))
  const nFrames = Math.floor((len - winN) / hopN)
  if (nFrames < 10) return 0

  const energy = new Float32Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    const s = i * hopN
    let e = 0
    for (let j = s; j < s + winN; j++) e += down[j] * down[j]
    energy[i] = Math.sqrt(e / winN)
  }

  const onset = new Float32Array(nFrames)
  for (let i = 1; i < nFrames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1])

  // Beat period in frames — kept FRACTIONAL. Rounding to an integer period
  // accumulated up to ~160 ms of drift across the fold window, smearing the
  // histogram and biasing the chosen phase.
  const hopSec = hopN / actual
  const beatFrames = (60 / bpm) / hopSec
  if (beatFrames < 1) return 0

  // Score sub-frame phases: walk the envelope at the exact fractional period
  // (linear interpolation between frames), 4 phase steps per frame.
  const steps = Math.max(1, Math.ceil(beatFrames * 4))
  let bestPhase = 0
  let bestScore = -1
  for (let s = 0; s < steps; s++) {
    const p = (s / steps) * beatFrames
    let score = 0
    for (let t = p; t < nFrames - 1; t += beatFrames) {
      const i = Math.floor(t)
      const fr = t - i
      score += onset[i] * (1 - fr) + onset[i + 1] * fr
    }
    if (score > bestScore) { bestScore = score; bestPhase = p }
  }

  return bestPhase * hopSec * 1000  // → milliseconds
}

// ── Energy scoring (1–10) ─────────────────────────────────────────────────────
// Computes the 75th-percentile RMS energy of the track (skipping quiet intros)
// and maps it to a 1–10 scale calibrated for mastered dance music.

function detectEnergy(samples: Float32Array, sampleRate: number): number | null {
  const TARGET = 4000
  const factor  = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual  = sampleRate / factor

  // Limit to 3 minutes of audio
  const maxSrc = Math.min(samples.length, sampleRate * 180)
  const len    = Math.floor(maxSrc / factor)
  if (len < 200) return null

  // Downsample: compute mean-square per block (preserves correct RMS after sqrt)
  const sq = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    const base = i * factor
    const end  = Math.min(base + factor, maxSrc)
    for (let j = base; j < end; j++) s += samples[j] * samples[j]
    sq[i] = s / (end - base)
  }

  // RMS in 0.5-second windows (non-overlapping)
  const winN   = Math.max(1, Math.floor(actual * 0.5))
  const nFrames = Math.floor(len / winN)
  if (nFrames < 4) return null

  const rms = new Float32Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    const s = i * winN
    let e = 0
    for (let j = s; j < s + winN; j++) e += sq[j]
    rms[i] = Math.sqrt(e / winN)
  }

  // Sort and take 75th percentile, skipping the first 5% of frames (quiet intros)
  const skip  = Math.max(1, Math.floor(nFrames * 0.05))
  const valid = Array.from(rms.subarray(skip)).sort((a, b) => a - b)
  const p75   = valid[Math.floor(valid.length * 0.75)]
  if (!p75) return null

  // Log scale: 0.005 → 1, 0.30 → 10
  // Typical values: ambient ~0.01 (→3), house ~0.08 (→7), loud techno ~0.20 (→9)
  const score = 1 + (Math.log10(Math.max(0.005, p75) / 0.005) / Math.log10(60)) * 9
  return Math.min(10, Math.max(1, Math.round(score)))
}

// ── Danceability (0–1) ───────────────────────────────────────────────────────
// Two components averaged together:
//   1. Beat regularity — how strongly the onset energy concentrates at BPM-period
//      positions (fold the onset envelope at the beat period, measure peak/mean).
//      High → steady kick, regular groove. Low → rubato, irregular.
//   2. Attack sharpness — fraction of onset spikes that are "punchy" (rise quickly
//      relative to the surrounding energy). Kick-heavy tracks score high.

function detectDanceability(
  samples: Float32Array,
  sampleRate: number,
  bpm: number | null
): number | null {
  const TARGET = 4000
  const factor = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual = sampleRate / factor
  const maxSrc = Math.min(samples.length, sampleRate * 90)  // first 90 s is enough
  const len = Math.floor(maxSrc / factor)
  if (len < 200) return null

  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += Math.abs(samples[i * factor + j])
    down[i] = s / factor
  }

  const winN = Math.max(1, Math.floor(actual * 0.02))
  const hopN = Math.max(1, Math.floor(winN / 2))
  const nFrames = Math.floor((len - winN) / hopN)
  if (nFrames < 10) return null

  const env = new Float32Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    const s = i * hopN
    let e = 0
    for (let j = s; j < s + winN; j++) e += down[j] * down[j]
    env[i] = Math.sqrt(e / winN)
  }

  const onset = new Float32Array(nFrames)
  for (let i = 1; i < nFrames; i++) onset[i] = Math.max(0, env[i] - env[i - 1])

  // ── Component 1: beat regularity (fold at BPM period) ──────────────────
  let regularity = 0.5  // neutral fallback if no BPM
  if (bpm != null && bpm > 0) {
    const hopSec = hopN / actual
    const period = Math.round((60 / bpm) / hopSec)
    if (period >= 2) {
      const folded = new Float32Array(period)
      for (let i = 0; i < nFrames; i++) folded[i % period] += onset[i]

      let total = 0
      let peak = 0
      for (let i = 0; i < period; i++) {
        total += folded[i]
        if (folded[i] > peak) peak = folded[i]
      }
      const mean = total / period
      if (mean > 0) {
        // peak-to-mean ratio: ~1.5 = irregular, ~8+ = very regular
        const ratio = peak / mean
        regularity = Math.max(0, Math.min(1, (ratio - 1.2) / 7.0))
      }
    }
  }

  // ── Component 2: attack sharpness (punchy transients) ──────────────────
  const meanOnset = onset.reduce((s, v) => s + v, 0) / nFrames
  if (meanOnset === 0) return regularity

  // Coefficient of variation: high variance relative to mean = punchy attacks
  let variance = 0
  for (let i = 0; i < nFrames; i++) {
    const d = onset[i] - meanOnset
    variance += d * d
  }
  const cv = Math.sqrt(variance / nFrames) / meanOnset
  // Typical values: ambient ~0.3, house/techno ~1.5–3.0, very punchy ~4+
  const sharpness = Math.max(0, Math.min(1, (cv - 0.3) / 3.2))

  return Math.round((regularity * 0.6 + sharpness * 0.4) * 100) / 100
}

// ── Structural cue detection ──────────────────────────────────────────────────
// Analyses the energy envelope against the bar grid to find four musically
// significant points: mix-in (intro end), first drop, breakdown, outro start.
// All positions are snapped to the nearest phrase boundary (multiple of 4 bars).
// Only called when BPM + beat phase are already known.

function detectStructuralCues(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
  offsetMs: number,
  providedBars?: number[],
): SuggestedCue[] {
  const durMs = (samples.length / sampleRate) * 1000

  // Prefer the real analysed downbeats (sample-accurate, true bar 1); fall back
  // to a grid derived from the crude BPM + beat phase only when none are given.
  let bars: number[]
  if (providedBars != null && providedBars.length >= 8) {
    bars = providedBars.filter((b) => b >= 0 && b < durMs).sort((a, b) => a - b)
  } else if (bpm > 0) {
    const barMs0 = (60000 / bpm) * 4
    let t0 = offsetMs % barMs0
    if (t0 < 0) t0 += barMs0
    bars = []
    for (let t = t0; t < durMs; t += barMs0) bars.push(t)
  } else {
    return []
  }
  if (bars.length < 8) return []

  // Mean bar length — real grids can vary slightly; used for energy windows.
  const barMs = (bars[bars.length - 1] - bars[0]) / (bars.length - 1)

  // Downsample to ~4 kHz for fast energy computation — over the FULL track.
  // A 6-minute cap here put Break/Outro auto-cues in the wrong place on any
  // longer track (the energy curve simply ended at 6:00).
  const TARGET = 4000
  const factor  = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual  = sampleRate / factor
  const len     = Math.floor(samples.length / factor)

  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    for (let j = 0; j < factor; j++) s += Math.abs(samples[i * factor + j] ?? 0)
    down[i] = s / factor
  }

  // RMS per bar (window = this downbeat → the next one)
  const barRms = bars.map((barStart, idx) => {
    const barEnd = idx + 1 < bars.length ? bars[idx + 1] : barStart + barMs
    const s0 = Math.floor((barStart / 1000) * actual)
    const s1 = Math.min(len, Math.floor((barEnd / 1000) * actual))
    if (s1 <= s0) return 0
    let sum = 0
    for (let i = s0; i < s1; i++) sum += down[i] * down[i]
    return Math.sqrt(sum / (s1 - s0))
  })

  // 3-bar moving-average smooth
  const smooth = barRms.map((_, i) => {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(barRms.length - 1, i + 1)
    let s = 0
    for (let j = lo; j <= hi; j++) s += barRms[j]
    return s / (hi - lo + 1)
  })

  const maxE = Math.max(...smooth)
  if (maxE === 0) return []
  const norm = smooth.map((v) => v / maxE)

  // Helper: snap bar index to the nearest multiple of `phrase` bars
  const snap = (i: number, phrase: number): number =>
    Math.min(bars.length - 1, Math.max(0, Math.round(i / phrase) * phrase))

  const cues: SuggestedCue[] = []

  // ── Cue 1: mix-in (intro end) ─────────────────────────────────────────────
  // First bar where energy rises above 35% and sustains for 3+ bars.
  // Snapped to an 8-bar phrase boundary so it's always on a musical grid.
  let mixInBar = -1
  for (let i = 1; i < norm.length - 4; i++) {
    if (norm[i] > 0.35 && norm[i + 1] > 0.30 && norm[i + 2] > 0.28) {
      mixInBar = snap(i, 8)
      break
    }
  }
  if (mixInBar < 0) mixInBar = Math.min(8, bars.length - 1)

  if (mixInBar < bars.length) {
    cues.push({ positionMs: bars[mixInBar], label: 'Mix In', color: '#3CA86A' })
  }

  // ── Cue 2: first drop ─────────────────────────────────────────────────────
  // Global energy peak after mix-in + 8 bars, snapped to 4-bar phrase.
  const dropSearchStart = mixInBar + 8
  let dropBar = -1, dropVal = -1
  for (let i = dropSearchStart; i < norm.length - 2; i++) {
    if (norm[i] > dropVal) { dropVal = norm[i]; dropBar = i }
  }
  if (dropBar >= 0) {
    dropBar = snap(dropBar, 4)
    cues.push({ positionMs: bars[dropBar], label: 'Drop', color: '#D86A4A' })
  }

  // ── Cue 3: breakdown ──────────────────────────────────────────────────────
  // First significant energy dip (< 60 % of drop level) after drop + 4 bars.
  if (dropBar >= 0) {
    let bdBar = -1, bdVal = 2
    const dropLevel = norm[dropBar] * 0.60
    for (let i = dropBar + 4; i < norm.length - 4; i++) {
      if (norm[i] < dropLevel && norm[i] < bdVal) { bdVal = norm[i]; bdBar = i }
    }
    if (bdBar >= 0) {
      bdBar = snap(bdBar, 4)
      cues.push({ positionMs: bars[bdBar], label: 'Break', color: '#3CA8C0' })
    }
  }

  // ── Cue 4: outro ─────────────────────────────────────────────────────────
  // Last point where energy falls below 40 % and stays low until the end.
  // Must be in the second half of the track and leave at least 8 bars of outro.
  const halfBar = Math.floor(bars.length / 2)
  let outroBar  = -1
  for (let i = bars.length - 2; i > halfBar; i--) {
    if (norm[i] > 0.42) { outroBar = i + 1; break }
  }
  if (outroBar >= 0 && bars.length - outroBar >= 8 && outroBar !== dropBar) {
    outroBar = snap(outroBar, 4)
    if (outroBar < bars.length)
      cues.push({ positionMs: bars[outroBar], label: 'Outro', color: '#A855C8' })
  }

  return cues
}

// ── Mood / Valence (−1 dark → +1 euphoric) ───────────────────────────────────
// Three factors combine into a raw valence score, then normalised to [−1, 1]:
//
//   spectralBrightness = energy above 2 kHz / total energy
//     → high treble content = bright, airy, positive
//   bassWeight = energy below 200 Hz / total energy
//     → heavy bass dominance = dark, tense, negative
//   keyModeBonus = +0.20 for major keys (Camelot "B"), −0.15 for minor ("A")
//
// rawValence = spectralBrightness − bassWeight × 0.6 + keyModeBonus
// Scaled to [−1, 1] using empirical bounds (−0.4 … +0.6 in practice).

function detectMood(samples: Float32Array, sampleRate: number, key: string | null): number | null {
  // Key mode bonus (Camelot: B suffix = major, A suffix = minor)
  const isMajor = key ? key.toUpperCase().endsWith('B') : null
  const keyModeBonus = isMajor === null ? 0 : isMajor ? 0.20 : -0.15

  // Work at ~11 kHz — captures up to 5.5 kHz which covers the "brightness" band
  const TARGET  = 11025
  const factor  = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual  = sampleRate / factor
  const maxSrc  = Math.min(samples.length, sampleRate * 60)   // first 60 s is enough
  const len     = Math.floor(maxSrc / factor)

  if (len < 1024) {
    // Too short — rely only on key mode
    return Math.max(-1, Math.min(1, Math.round(keyModeBonus * 100) / 100))
  }

  // Downsample
  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    const base = i * factor
    const end  = Math.min(base + factor, maxSrc)
    for (let j = base; j < end; j++) s += samples[j]
    down[i] = s / (end - base)
  }

  // Hann window + FFT over 1024-sample frames, 512-sample hop
  const FFT_SIZE = 1024
  const HOP      = 512
  const nFrames  = Math.floor((len - FFT_SIZE) / HOP)

  const hann = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))

  let totalPow = 0, bassPow = 0, highPow = 0

  for (let frame = 0; frame < nFrames; frame++) {
    const start = frame * HOP
    const re    = new Float64Array(FFT_SIZE)
    const im    = new Float64Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) re[i] = (down[start + i] ?? 0) * hann[i]

    fft(re, im)

    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const freq  = bin * actual / FFT_SIZE
      const power = re[bin] * re[bin] + im[bin] * im[bin]
      totalPow += power
      if (freq < 200)  bassPow  += power
      if (freq > 2000) highPow  += power
    }
  }

  if (totalPow === 0) {
    return Math.max(-1, Math.min(1, Math.round(keyModeBonus * 100) / 100))
  }

  const spectralBrightness = highPow / totalPow
  const bassWeight         = bassPow / totalPow

  // Combine: brightness pulls positive, bass pulls negative, mode adjusts
  const rawValence = spectralBrightness - bassWeight * 0.6 + keyModeBonus

  // Empirical bounds: rawValence typically sits in [−0.4, +0.6].
  // Map that range linearly to [−1, +1].
  const normalised = (rawValence - 0.1) / 0.5   // centre ~0.1, scale ÷0.5
  return Math.max(-1, Math.min(1, Math.round(normalised * 100) / 100))
}

// ── Cooley-Tukey radix-2 in-place FFT ────────────────────────────────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]];
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0
      for (let j = 0; j < len >> 1; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const k = i + j + (len >> 1)
        const vRe = re[k] * cRe - im[k] * cIm
        const vIm = re[k] * cIm + im[k] * cRe
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm
        re[k] = uRe - vRe; im[k] = uIm - vIm
        const nextRe = cRe * wRe - cIm * wIm
        cIm = cRe * wIm + cIm * wRe
        cRe = nextRe
      }
    }
  }
}
