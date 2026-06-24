/**
 * audioFeatures.ts — a compact, dependency-free "content fingerprint" for a
 * track, used for local "sounds like this" similarity.
 *
 * This is a HANDCRAFTED feature vector (timbre + harmony + spectral shape), not
 * a learned embedding — a v1 that needs no model file and no Python. The vector
 * is stored per track; similarity standardises each dimension across the library
 * (see findSimilar in similarity.ts) and ranks by cosine. The public shape
 * (a fixed-length number[]) is deliberately model-agnostic so an ONNX embedding
 * can be swapped in later without touching consumers.
 *
 * Pure + node-testable (operates on Float32Array, no Web Audio).
 */

/** Bump when the feature layout/algorithm changes, to trigger re-analysis. */
export const FEATURE_VERSION = 1

const FRAME = 2048
const HOP = 1024
const N_MELS = 40
const N_MFCC = 13
// 13 mfcc mean + 13 mfcc std + 12 chroma + 5 spectral = 43
export const FEATURE_DIM = N_MFCC * 2 + 12 + 5

// ── FFT (in-place radix-2; mirrors analyzerWorker's proven implementation) ─────
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
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

const hann = (() => {
  const w = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  return w
})()

const hzToMel = (f: number): number => 2595 * Math.log10(1 + f / 700)
const melToHz = (m: number): number => 700 * (Math.pow(10, m / 2595) - 1)

/** Triangular mel filterbank over the rFFT bins for a given sample rate. */
function melFilterbank(fs: number): Float64Array[] {
  const bins = FRAME / 2 + 1
  const fMax = fs / 2
  const pts = new Float64Array(N_MELS + 2)
  const melMax = hzToMel(fMax)
  for (let i = 0; i < pts.length; i++) {
    const hz = melToHz((i / (N_MELS + 1)) * melMax)
    pts[i] = Math.floor((hz / fMax) * (bins - 1))
  }
  const filters: Float64Array[] = []
  for (let m = 1; m <= N_MELS; m++) {
    const f = new Float64Array(bins)
    const a = pts[m - 1], b = pts[m], c = pts[m + 1]
    for (let k = a; k < b; k++) if (b > a) f[k] = (k - a) / (b - a)
    for (let k = b; k < c; k++) if (c > b) f[k] = (c - k) / (c - b)
    filters.push(f)
  }
  return filters
}

/** DCT-II of the log-mel energies, keeping the first N_MFCC coefficients. */
function dct(input: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n)
  const N = input.length
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = 0; i < N; i++) s += input[i] * Math.cos((Math.PI / N) * (i + 0.5) * k)
    out[k] = s
  }
  return out
}

/** Running mean/variance accumulator (Welford). */
class Stat {
  n = 0; mean = 0; m2 = 0
  push(x: number): void {
    this.n++
    const d = x - this.mean
    this.mean += d / this.n
    this.m2 += d * (x - this.mean)
  }
  get std(): number { return this.n > 1 ? Math.sqrt(this.m2 / this.n) : 0 }
}

/**
 * Compute the content feature vector for a mono signal. To bound cost and bias,
 * up to `windowSecs` from the centre of the track is analysed (skipping intros
 * /outros), like the auto-gain reader.
 */
export function audioFeatureVector(mono: Float32Array, fs: number, windowSecs = 90): number[] {
  // Centre window
  const want = Math.min(mono.length, Math.round(windowSecs * fs))
  const start = Math.max(0, Math.floor((mono.length - want) / 2))
  const end = Math.min(mono.length, start + want)

  const mel = melFilterbank(fs)
  const bins = FRAME / 2 + 1
  const mfccStats = Array.from({ length: N_MFCC }, () => new Stat())
  const chroma = new Float64Array(12)
  let chromaFrames = 0
  const centroidS = new Stat(), rolloffS = new Stat(), flatS = new Stat(), bwS = new Stat(), zcrS = new Stat()

  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  const binHz = fs / FRAME

  for (let pos = start; pos + FRAME <= end; pos += HOP) {
    // windowed frame + ZCR (time domain)
    let zc = 0
    for (let i = 0; i < FRAME; i++) {
      const s = mono[pos + i]
      re[i] = s * hann[i]
      im[i] = 0
      if (i > 0 && ((mono[pos + i] >= 0) !== (mono[pos + i - 1] >= 0))) zc++
    }
    zcrS.push(zc / FRAME)

    fft(re, im)

    // power spectrum + magnitude over the first `bins`
    let magSum = 0, weightedF = 0, powSum = 0, logPowSum = 0, magForBw = 0
    const power = new Float64Array(bins)
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      power[k] = p
      const mag = Math.sqrt(p)
      const f = k * binHz
      magSum += mag
      weightedF += mag * f
      powSum += p
      logPowSum += Math.log(p + 1e-12)
      // chroma
      if (f >= 27.5 && f <= fs / 2) {
        const midi = 69 + 12 * Math.log2(f / 440)
        const pc = ((Math.round(midi) % 12) + 12) % 12
        chroma[pc] += mag
      }
    }
    if (magSum < 1e-9) continue

    // MFCC: mel energies → log → DCT
    const logMel = new Float64Array(N_MELS)
    for (let m = 0; m < N_MELS; m++) {
      let e = 0
      const f = mel[m]
      for (let k = 0; k < bins; k++) e += power[k] * f[k]
      logMel[m] = Math.log(e + 1e-10)
    }
    const coeffs = dct(logMel, N_MFCC)
    for (let c = 0; c < N_MFCC; c++) mfccStats[c].push(coeffs[c])

    // spectral descriptors
    const centroid = weightedF / magSum
    centroidS.push(centroid / (fs / 2))
    // rolloff 85%
    let acc = 0, rollHz = 0
    const thresh = 0.85 * magSum
    for (let k = 0; k < bins; k++) { acc += Math.sqrt(power[k]); if (acc >= thresh) { rollHz = k * binHz; break } }
    rolloffS.push(rollHz / (fs / 2))
    // flatness = geomean/arithmean of power
    flatS.push(Math.exp(logPowSum / bins) / (powSum / bins + 1e-12))
    // bandwidth (spread around centroid)
    for (let k = 0; k < bins; k++) { const mag = Math.sqrt(power[k]); magForBw += mag * (k * binHz - centroid) ** 2 }
    bwS.push(Math.sqrt(magForBw / magSum) / (fs / 2))

    chromaFrames++
  }

  // assemble fixed-length vector
  const v: number[] = []
  for (let c = 0; c < N_MFCC; c++) v.push(mfccStats[c].mean)
  for (let c = 0; c < N_MFCC; c++) v.push(mfccStats[c].std)
  // chroma normalised to sum 1
  const chromaSum = chroma.reduce((a, b) => a + b, 0) || 1
  for (let pc = 0; pc < 12; pc++) v.push(chroma[pc] / chromaSum)
  v.push(centroidS.mean, rolloffS.mean, flatS.mean, bwS.mean, zcrS.mean)

  return v.map((x) => (Number.isFinite(x) ? x : 0))
}
