// Mel spectrogram parameters matching Beat This! training configuration
// (torchaudio.transforms.MelSpectrogram defaults with these explicit values)
export const MEL_CONFIG = {
  sampleRate: 22050,
  nFft:       2048,
  hopLength:  441,   // 20ms per frame at 22050 Hz
  nMels:      128,
  fMin:       30.0,
  fMax:       11000.0,
} as const

const { nFft, nMels, fMin, fMax, sampleRate, hopLength } = MEL_CONFIG
const N_FREQ_BINS = nFft / 2 + 1

// ── Hann window ───────────────────────────────────────────────────────────────

const HANN_WINDOW: Float32Array = (() => {
  const w = new Float32Array(nFft)
  for (let i = 0; i < nFft; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (nFft - 1)))
  return w
})()

// ── Cooley-Tukey radix-2 DIT FFT (in-place, power-of-2 N) ───────────────────

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0
      const half = len >> 1
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j],    uIm = im[i + j]
        const vRe = re[i + j + half] * cRe - im[i + j + half] * cIm
        const vIm = re[i + j + half] * cIm + im[i + j + half] * cRe
        re[i + j]        = uRe + vRe;  im[i + j]        = uIm + vIm
        re[i + j + half] = uRe - vRe;  im[i + j + half] = uIm - vIm
        const nRe = cRe * wRe - cIm * wIm
        cIm = cRe * wIm + cIm * wRe
        cRe = nRe
      }
    }
  }
}

// ── Mel filterbank (HTK scale, Slaney area normalisation) ────────────────────

function hzToMel(hz: number): number { return 2595 * Math.log10(1 + hz / 700) }
function melToHz(mel: number): number { return 700 * (10 ** (mel / 2595) - 1) }

const MEL_FILTERBANK: Float32Array[] = (() => {
  const melMin = hzToMel(fMin)
  const melMax = hzToMel(fMax)
  // nMels + 2 centre points (includes outer edges)
  const melPts = Array.from({ length: nMels + 2 }, (_, i) => melMin + (melMax - melMin) * i / (nMels + 1))
  const hzPts  = melPts.map(melToHz)
  const binPts = hzPts.map((f) => Math.floor((nFft + 1) * f / sampleRate))

  return Array.from({ length: nMels }, (_, m) => {
    const filter = new Float32Array(N_FREQ_BINS)
    const lo = binPts[m], center = binPts[m + 1], hi = binPts[m + 2]
    for (let k = lo; k < center && k < N_FREQ_BINS; k++)
      filter[k] = (k - lo) / (center - lo)
    for (let k = center; k < hi && k < N_FREQ_BINS; k++)
      filter[k] = (hi - k) / (hi - center)
    // Slaney normalisation: divide by bandwidth
    const bw = hzPts[m + 2] - hzPts[m]
    if (bw > 0) { const n = 2 / bw; for (let k = 0; k < N_FREQ_BINS; k++) filter[k] *= n }
    return filter
  })
})()

// ── Public API ────────────────────────────────────────────────────────────────

const YIELD_EVERY = 10   // yield to event loop every N frames (~1-2ms chunks)

/**
 * Compute a log-mel spectrogram from mono PCM samples.
 * Async so it can yield to the Node.js event loop periodically, keeping
 * the main process responsive during long batch analysis runs.
 * Returns a flat Float32Array of shape [numFrames × nMels].
 */
export async function computeMelSpectrogram(
  samples: Float32Array
): Promise<{ data: Float32Array; numFrames: number }> {
  const re = new Float32Array(nFft)
  const im = new Float32Array(nFft)
  const numFrames = Math.floor((samples.length - nFft) / hopLength) + 1
  const out = new Float32Array(numFrames * nMels)

  for (let f = 0; f < numFrames; f++) {
    // Yield every YIELD_EVERY frames so IPC and GC can run between chunks
    if (f > 0 && f % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const offset = f * hopLength
    for (let i = 0; i < nFft; i++) {
      re[i] = (offset + i < samples.length ? samples[offset + i] : 0) * HANN_WINDOW[i]
      im[i] = 0
    }
    fftInPlace(re, im)

    const melBase = f * nMels
    for (let m = 0; m < nMels; m++) {
      let energy = 0
      const filter = MEL_FILTERBANK[m]
      for (let k = 0; k < N_FREQ_BINS; k++) {
        energy += (re[k] * re[k] + im[k] * im[k]) * filter[k]
      }
      out[melBase + m] = Math.max(10 * Math.log10(energy + 1e-10), -80)
    }
  }

  return { data: out, numFrames }
}
