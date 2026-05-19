// Runs in a Web Worker thread — no DOM or Electron APIs available here.

export interface AnalyzerInput {
  samples: Float32Array   // mono, original sample rate
  sampleRate: number
}

export interface AnalyzerResult {
  bpm: number | null
  key: string | null      // Camelot notation e.g. "8B"
}

self.onmessage = (e: MessageEvent<AnalyzerInput>) => {
  const { samples, sampleRate } = e.data
  const bpm = detectBPM(samples, sampleRate)
  const key = detectKey(samples, sampleRate)
  self.postMessage({ bpm, key } satisfies AnalyzerResult)
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

  let bestBPM: number | null = null
  let bestCorr = -Infinity

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < useN - lag; i++) corr += onset[i] * onset[i + lag]
    if (corr > bestCorr) { bestCorr = corr; bestBPM = 60 / (lag * hopSec) }
  }

  if (!bestBPM) return null

  // Check if half/double is a better "canonical" tempo (keep in 80–160 range)
  const half = bestBPM / 2
  const dbl = bestBPM * 2
  if (half >= 80 && half <= 160) bestBPM = half
  else if (dbl >= 80 && dbl <= 160) bestBPM = dbl

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
