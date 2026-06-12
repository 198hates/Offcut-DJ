// Log-mel spectrogram matching the Beat This! training configuration EXACTLY
// (CPJKU/beat_this preprocessing.LogMelSpect → torchaudio MelSpectrogram):
//   sample_rate 22050 · n_fft 1024 · hop 441 (20 ms) · n_mels 128 · 30–11000 Hz
//   mel_scale "slaney" · filterbank norm None · power 1 (magnitude)
//   normalized "frame_length" (STFT ÷ √n_fft) · center=True (reflect pad)
//   output log1p(1000 · mel)
// The previous implementation used n_fft 2048, the HTK mel scale, Slaney area
// normalisation, a POWER spectrum, dB scaling with a −80 floor, and no frame
// centering — the model received out-of-distribution input and every frame was
// time-shifted by ~+23 ms.
export const MEL_CONFIG = {
  sampleRate: 22050,
  nFft:       1024,
  hopLength:  441,   // 20ms per frame at 22050 Hz
  nMels:      128,
  fMin:       30.0,
  fMax:       11000.0,
} as const

const { nFft, nMels, fMin, fMax, sampleRate, hopLength } = MEL_CONFIG
const N_FREQ_BINS = nFft / 2 + 1
/** torchaudio normalized="frame_length": STFT divided by √win_length. */
const STFT_NORM = 1 / Math.sqrt(nFft)

// ── Hann window (periodic, like torch.hann_window) ───────────────────────────

const HANN_WINDOW: Float32Array = (() => {
  const w = new Float32Array(nFft)
  for (let i = 0; i < nFft; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / nFft))
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

// ── Slaney mel scale (torchaudio mel_scale="slaney") ─────────────────────────
// Linear below 1 kHz (mel = hz / (200/3)), logarithmic above.

const F_SP = 200 / 3
const MIN_LOG_HZ = 1000
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP
const LOG_STEP = Math.log(6.4) / 27

function hzToMel(hz: number): number {
  return hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : hz / F_SP
}
function melToHz(mel: number): number {
  return mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)) : mel * F_SP
}

// ── Mel filterbank (torchaudio melscale_fbanks, norm=None) ───────────────────
// Continuous triangles evaluated at each FFT bin's frequency — torchaudio does
// NOT floor frequencies to bin indices, and with norm=None there is no area
// normalisation.

const MEL_FILTERBANK: Float32Array[] = (() => {
  const melMin = hzToMel(fMin)
  const melMax = hzToMel(fMax)
  // n_mels + 2 edge points
  const fPts = Array.from({ length: nMels + 2 }, (_, i) =>
    melToHz(melMin + (melMax - melMin) * i / (nMels + 1))
  )
  // Bin centre frequencies: linspace(0, sr/2, n_freqs)
  const binHz = Array.from({ length: N_FREQ_BINS }, (_, k) =>
    (k * (sampleRate / 2)) / (N_FREQ_BINS - 1)
  )
  return Array.from({ length: nMels }, (_, m) => {
    const filter = new Float32Array(N_FREQ_BINS)
    const lo = fPts[m], mid = fPts[m + 1], hi = fPts[m + 2]
    for (let k = 0; k < N_FREQ_BINS; k++) {
      const up   = (binHz[k] - lo) / (mid - lo)
      const down = (hi - binHz[k]) / (hi - mid)
      filter[k] = Math.max(0, Math.min(up, down))
    }
    return filter
  })
})()

// ── Public API ────────────────────────────────────────────────────────────────

const YIELD_EVERY = 10   // yield to event loop every N frames (~1-2ms chunks)

/**
 * Compute a log-mel spectrogram from mono PCM samples (22 050 Hz).
 * Async so it can yield to the Node.js event loop periodically, keeping
 * the main process responsive during long batch analysis runs.
 * Returns a flat Float32Array of shape [numFrames × nMels]; frame `f` is
 * CENTRED at `f · hopLength` samples (torchaudio center=True semantics), so
 * positions map to time as exactly `f × 20 ms`.
 */
export async function computeMelSpectrogram(
  samples: Float32Array
): Promise<{ data: Float32Array; numFrames: number }> {
  const re = new Float32Array(nFft)
  const im = new Float32Array(nFft)
  const pad = nFft / 2
  // torchaudio center=True: n_frames = 1 + floor(len / hop)
  const numFrames = 1 + Math.floor(samples.length / hopLength)
  const out = new Float32Array(numFrames * nMels)

  // Reflect-padded sample lookup (centered frames read up to `pad` outside).
  const n = samples.length
  const sampleAt = (idx: number): number => {
    if (idx < 0) idx = -idx
    if (idx >= n) idx = 2 * n - 2 - idx
    return idx >= 0 && idx < n ? samples[idx] : 0
  }

  for (let f = 0; f < numFrames; f++) {
    // Yield every YIELD_EVERY frames so IPC and GC can run between chunks
    if (f > 0 && f % YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const start = f * hopLength - pad
    for (let i = 0; i < nFft; i++) {
      re[i] = sampleAt(start + i) * HANN_WINDOW[i]
      im[i] = 0
    }
    fftInPlace(re, im)

    const melBase = f * nMels
    for (let m = 0; m < nMels; m++) {
      let acc = 0
      const filter = MEL_FILTERBANK[m]
      for (let k = 0; k < N_FREQ_BINS; k++) {
        if (filter[k] !== 0) {
          // power=1 → magnitude, with frame-length STFT normalisation
          acc += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * STFT_NORM * filter[k]
        }
      }
      // log1p(log_multiplier · mel)
      out[melBase + m] = Math.log1p(1000 * acc)
    }
  }

  return { data: out, numFrames }
}
