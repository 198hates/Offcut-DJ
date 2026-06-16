// Runs in a Web Worker thread — no DOM or Electron APIs available here.

export interface AnalyzerInput {
  samples: Float32Array   // mono, original sample rate
  sampleRate: number
  /** Real downbeat positions (ms) from the analysed beatgrid, if available —
   *  used to anchor structural cues to true bars instead of a re-derived grid. */
  bars?: number[]
  /** Multiplier on the structural-cue confidence thresholds (auto-cue template
   *  sensitivity). <1 emits more cues, >1 fewer. Defaults to 1. */
  cueThresholdScale?: number
}

export interface SuggestedCue {
  positionMs: number
  label: string
  color: string
  /** 0–1 detector confidence (Phase D) — how strongly the audio supports this cue. */
  confidence?: number
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
  const { samples, sampleRate, bars, cueThresholdScale } = e.data
  const bpm          = detectBPM(samples, sampleRate)
  const key          = detectKey(samples, sampleRate)
  const energy       = detectEnergy(samples, sampleRate)
  const danceability = detectDanceability(samples, sampleRate, bpm)
  const mood         = detectMood(samples, sampleRate, key)
  const offsetMs     = bpm != null ? detectBeatPhase(samples, sampleRate, bpm) : null
  // Cues need a bar grid: real downbeats if supplied, else the crude BPM/phase one.
  const haveGrid = (bars != null && bars.length >= 8) || (bpm != null && offsetMs != null)
  const suggestedCues = haveGrid
    ? detectStructuralCues(samples, sampleRate, bpm ?? 0, offsetMs ?? 0, bars, cueThresholdScale)
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
  thresholdScale = 1,
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

  // ── Band-split energy per bar (Phase B) ───────────────────────────────────
  // In dance music the KICK/BASS is the structural signal — it's what enters at
  // the mix-in, drops out in a breakdown, and slams back in at the drop. A
  // single broadband RMS conflates that with pads/vocals/risers, which is why a
  // breakdown (kick gone, pads sustaining) used to read as "still high energy".
  // So we split each bar into low (<200 Hz), mid and high, and cue on the bands.
  const { low, mid, high, full } = bandEnergyPerBar(samples, sampleRate, bars, barMs)

  // Robust per-track normalisation: divide by the 90th-percentile bar level,
  // not the single max. This makes the thresholds below adapt to each track's
  // own loudness instead of being absolute amplitudes (one loud transient no
  // longer crushes the whole curve).
  const lowN  = robustNorm(low)
  const midN  = robustNorm(mid)
  const highN = robustNorm(high)
  const fullN = robustNorm(full)
  const nBars = bars.length
  if (nBars === 0) return []

  // ── Phrase detection (Phase C) ────────────────────────────────────────────
  // Dance music is built in 16- or 32-bar phrases, and every structural change
  // (drop, breakdown, outro) lands on a phrase boundary. We find that grid by
  // measuring where the biggest bar-to-bar energy CHANGES line up: for each
  // candidate phrase length + phase, score the average "novelty" at the bars
  // that would be phrase starts, and keep the best. Cues then snap to this
  // detected phrase grid instead of an arbitrary multiple of 4/8 from bar 0.
  const novelty = new Float32Array(nBars)
  for (let i = 1; i < nBars; i++)
    novelty[i] = Math.abs(fullN[i] - fullN[i - 1]) + Math.abs(lowN[i] - lowN[i - 1])

  const phraseFit = (P: number): { phi: number; score: number } => {
    let bestPhi = 0, best = -1
    for (let phi = 0; phi < P; phi++) {
      let s = 0, c = 0
      for (let i = phi; i < nBars; i += P) { s += novelty[i]; c++ }
      const avg = c > 0 ? s / c : 0
      if (avg > best) { best = avg; bestPhi = phi }
    }
    return { phi: bestPhi, score: best }
  }

  let phraseLen = 16, phrasePhi = 0
  if (nBars < 24) {
    phraseLen = 8; phrasePhi = phraseFit(8).phi
  } else {
    const f16 = phraseFit(16)
    phraseLen = 16; phrasePhi = f16.phi
    if (nBars >= 64) {
      const f32 = phraseFit(32)
      if (f32.score > f16.score * 1.05) { phraseLen = 32; phrasePhi = f32.phi }
    }
  }

  // Snap a bar to the detected phrase grid. `denom` sub-divides the phrase:
  // 1 = phrase boundary, 2 = half-phrase (8 bars for a 16-bar phrase).
  const snapPhrase = (i: number, denom: number): number => {
    const step = Math.max(1, Math.round(phraseLen / denom))
    const k = Math.round((i - phrasePhi) / step)
    return Math.min(nBars - 1, Math.max(0, phrasePhi + k * step))
  }

  // Confidence helpers (Phase D): cues are only emitted when the audio supports
  // them, so an ambiguous track yields a few trustworthy cues, not guesses.
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  const mean = (a: Float32Array, lo: number, hi: number): number => {
    lo = Math.max(0, lo); hi = Math.min(a.length, hi)
    if (hi <= lo) return 0
    let s = 0
    for (let i = lo; i < hi; i++) s += a[i]
    return s / (hi - lo)
  }

  // ── Cue 1: mix-in (intro end) ─────────────────────────────────────────────
  // First bar where the KICK enters and sustains for 4+ bars, snapped to the
  // phrase grid. Confidence = how cleanly the low band steps up (after − before);
  // a track that already has kick from bar 1 has no real mix-in and scores ~0.
  let mixInBar = -1, mixInConf = 0
  for (let i = 1; i < nBars - 4; i++) {
    if (lowN[i] > 0.5 && lowN[i + 1] > 0.45 && lowN[i + 2] > 0.45 && lowN[i + 3] > 0.45) {
      mixInConf = clamp01(mean(lowN, i, i + 4) - mean(lowN, i - 4, i))
      mixInBar = snapPhrase(i, 2)
      break
    }
  }
  // Anchor downstream searches even when the mix-in itself isn't emitted.
  const searchAnchor = mixInBar >= 0 ? mixInBar : Math.min(phraseLen, nBars - 1)

  // ── Cue 2: first drop ─────────────────────────────────────────────────────
  // First strong full-energy re-entry after the intro: near peak (≥0.88), loud
  // kick (≥0.7), jumped up from the preceding 4 bars (≥0.15). Confidence scales
  // with the jump. Falls back to the global peak, scored by how far it stands
  // above the typical playing level — a flat track scores low and is dropped.
  const dropSearchStart = searchAnchor + 8
  let dropBar = -1, dropConf = 0
  for (let i = dropSearchStart; i < nBars - 2; i++) {
    let prevMin = Infinity
    for (let j = Math.max(0, i - 4); j < i; j++) if (fullN[j] < prevMin) prevMin = fullN[j]
    if (fullN[i] >= 0.88 && lowN[i] >= 0.7 && fullN[i] - prevMin >= 0.15) {
      dropConf = clamp01((fullN[i] - prevMin) * 1.5)
      dropBar = i
      break
    }
  }
  if (dropBar < 0) {
    const med = median(fullN)
    let v = -1
    for (let i = dropSearchStart; i < nBars - 2; i++) if (fullN[i] > v) { v = fullN[i]; dropBar = i }
    dropConf = clamp01((v - med) * 1.2)
  }
  if (dropBar >= 0) dropBar = snapPhrase(dropBar, 2)

  // ── Cue 3: build / riser (Phase C) ────────────────────────────────────────
  // The run-up into the drop: kick suppressed but mid/high climbing (snare
  // rolls, white-noise risers). Confidence scales with the size of the ramp.
  let buildBar = -1, buildConf = 0
  if (dropBar >= 0) {
    const intoDrop = midN[dropBar - 1] + highN[dropBar - 1]
    const from = Math.max(searchAnchor + 1, dropBar - 12)
    for (let i = from; i < dropBar - 1; i++) {
      const ramp = intoDrop - (midN[i] + highN[i])
      if (lowN[i] < 0.6 && ramp > 0.4) { buildConf = clamp01(ramp - 0.2); buildBar = snapPhrase(i, 2); break }
    }
    if (buildBar >= dropBar || buildBar <= searchAnchor) { buildBar = -1; buildConf = 0 }
  }

  // ── Cue 4: breakdown ──────────────────────────────────────────────────────
  // Deepest sustained KICK dip after the drop — 3 consecutive bars whose mean
  // low-band level falls below half. Confidence scales with how deep the dip is,
  // so a shallow lull doesn't masquerade as a breakdown.
  let bdBar = -1, bdConf = 0
  if (dropBar >= 0) {
    let bdVal = 2
    for (let i = dropBar + 4; i < nBars - 4; i++) {
      const seg = (lowN[i] + lowN[i + 1] + lowN[i + 2]) / 3
      if (seg < 0.5 && seg < bdVal) { bdVal = seg; bdBar = i }
    }
    if (bdBar >= 0) { bdConf = clamp01((0.6 - bdVal) * 1.5); bdBar = snapPhrase(bdBar, 2) }
  }

  // ── Cue 5: outro ──────────────────────────────────────────────────────────
  // Last point in the second half where the kick is still going; the outro
  // starts the bar after. Confidence = the low-band contrast across that edge.
  const halfBar = Math.floor(nBars / 2)
  let outroBar = -1, outroConf = 0
  for (let i = nBars - 2; i > halfBar; i--) {
    if (lowN[i] > 0.5) { outroBar = i + 1; break }
  }
  if (outroBar >= 0 && (nBars - outroBar < 8 || outroBar === dropBar)) outroBar = -1
  if (outroBar >= 0) {
    outroConf = clamp01(mean(lowN, outroBar - 4, outroBar) - mean(lowN, outroBar, outroBar + 4))
    outroBar = snapPhrase(outroBar, 1)
  }

  // ── Assemble — confidence-gated, one cue per bar, time-ordered ────────────
  // Insert in priority order so that when two cues snap to the same phrase bar,
  // the more important one wins; each must clear its per-type confidence
  // threshold; then emit sorted by position.
  const byBar = new Map<number, SuggestedCue>()
  const place = (bar: number, conf: number, thr: number, label: string, color: string): void => {
    if (bar < 0 || bar >= nBars || conf < thr * thresholdScale || byBar.has(bar)) return
    byBar.set(bar, { positionMs: bars[bar], label, color, confidence: Math.round(conf * 100) / 100 })
  }
  place(dropBar,  dropConf,  0.20, 'Drop',   '#D86A4A')
  place(bdBar,    bdConf,    0.18, 'Break',  '#3CA8C0')
  place(mixInBar, mixInConf, 0.22, 'Mix In', '#3CA86A')
  place(buildBar, buildConf, 0.20, 'Build',  '#E0B43C')
  place(outroBar, outroConf, 0.20, 'Outro',  '#A855C8')

  return Array.from(byBar.values()).sort((a, b) => a.positionMs - b.positionMs)
}

// ── Band-split bar energies (low / mid / high / full) ─────────────────────────
// STFT over the whole track at ~11 kHz; each frame's spectral power is split
// into low (<200 Hz), mid (200–2000 Hz) and high (>2000 Hz) and accumulated into
// the bar its centre falls in. Returns per-bar RMS for each band plus the sum.

interface BandBars { low: Float32Array; mid: Float32Array; high: Float32Array; full: Float32Array }

function bandEnergyPerBar(
  samples: Float32Array,
  sampleRate: number,
  bars: number[],
  barMs: number,
): BandBars {
  const nBars = bars.length
  const low = new Float32Array(nBars)
  const mid = new Float32Array(nBars)
  const high = new Float32Array(nBars)
  const full = new Float32Array(nBars)
  const cnt = new Float32Array(nBars)

  const TARGET = 11025
  const factor = Math.max(1, Math.floor(sampleRate / TARGET))
  const actual = sampleRate / factor
  const len = Math.floor(samples.length / factor)
  if (len < 1024) return { low, mid, high, full }

  const down = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    let s = 0
    const base = i * factor
    const end = Math.min(base + factor, samples.length)
    for (let j = base; j < end; j++) s += samples[j]
    down[i] = s / (end - base)
  }

  const FFT = 1024
  const HOP = 512
  const half = FFT >> 1
  const nFrames = Math.floor((len - FFT) / HOP)
  if (nFrames < 1) return { low, mid, high, full }

  const hann = new Float32Array(FFT)
  for (let i = 0; i < FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1))
  const re = new Float64Array(FFT)
  const im = new Float64Array(FFT)

  const lowMaxBin = Math.max(1, Math.floor((200 * FFT) / actual))
  const midMaxBin = Math.max(lowMaxBin, Math.floor((2000 * FFT) / actual))

  const lastBarEnd = bars[nBars - 1] + barMs
  let bi = 0
  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP
    for (let i = 0; i < FFT; i++) { re[i] = (down[start + i] ?? 0) * hann[i]; im[i] = 0 }
    fft(re, im)
    let lp = 0, mp = 0, hp = 0
    for (let bin = 1; bin < half; bin++) {
      const p = re[bin] * re[bin] + im[bin] * im[bin]
      if (bin <= lowMaxBin) lp += p
      else if (bin <= midMaxBin) mp += p
      else hp += p
    }
    const tc = ((start + half) / actual) * 1000   // frame-centre time (ms)
    if (tc < bars[0] || tc >= lastBarEnd) continue
    while (bi + 1 < nBars && tc >= bars[bi + 1]) bi++
    low[bi] += lp; mid[bi] += mp; high[bi] += hp; full[bi] += lp + mp + hp; cnt[bi]++
  }

  for (let i = 0; i < nBars; i++) {
    const c = cnt[i] || 1
    low[i] = Math.sqrt(low[i] / c)
    mid[i] = Math.sqrt(mid[i] / c)
    high[i] = Math.sqrt(high[i] / c)
    full[i] = Math.sqrt(full[i] / c)
  }
  return { low, mid, high, full }
}

// Normalise to the 90th-percentile of the non-zero values — a robust "near max"
// that isn't thrown off by a single loud transient. Output sits roughly in
// [0, 1.1]; values can slightly exceed 1 at the very loudest bars.
function robustNorm(arr: Float32Array): Float32Array {
  const sorted = Array.from(arr).filter((v) => v > 0).sort((a, b) => a - b)
  const out = new Float32Array(arr.length)
  if (sorted.length === 0) return out
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
  if (p90 > 0) for (let i = 0; i < arr.length; i++) out[i] = arr[i] / p90
  return out
}

// Median over the "active" bars (level > 0.05) — the typical playing level,
// used to score how far a fallback drop stands above the body of the track.
function median(arr: Float32Array): number {
  const s = Array.from(arr).filter((v) => v > 0.05).sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[s.length >> 1]
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
