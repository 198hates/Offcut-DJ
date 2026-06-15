/**
 * loudness.ts — ITU-R BS.1770 / EBU R128 integrated loudness (LUFS).
 *
 * The core operates on plain Float32Array channels + a sample rate so it is
 * pure and unit-testable in node (no Web Audio AudioBuffer). Thin wrappers at
 * the bottom adapt a decoded AudioBuffer for the renderer.
 *
 * Pipeline: K-weighting (two biquads) → 400 ms blocks at 75% overlap →
 * two-stage gating (absolute −70 LUFS, then relative −10 LU) → integrated LUFS.
 */

type Biquad = [b0: number, b1: number, b2: number, a1: number, a2: number]

// K-weighting analog parameters from BS.1770, realised as biquads at the actual
// sample rate (so 44.1k / 48k / 96k are all correct, not just the 48k table).

/** Stage 1 — high-shelf (+4 dB above ~1.5 kHz). */
function highShelf(fs: number): Biquad {
  const f0 = 1681.974450955533
  const Q = 0.7071752369554196
  const gainDb = 3.999843853973347
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const alpha = sw / (2 * Q)
  const beta = 2 * Math.sqrt(A) * alpha
  const b0 = A * ((A + 1) + (A - 1) * cw + beta)
  const b1 = -2 * A * ((A - 1) + (A + 1) * cw)
  const b2 = A * ((A + 1) + (A - 1) * cw - beta)
  const a0 = (A + 1) - (A - 1) * cw + beta
  const a1 = 2 * ((A - 1) - (A + 1) * cw)
  const a2 = (A + 1) - (A - 1) * cw - beta
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

/** Stage 2 — RLB high-pass (~38 Hz). */
function highPass(fs: number): Biquad {
  const f0 = 38.13547087602444
  const Q = 0.5003270373238773
  const w0 = (2 * Math.PI * f0) / fs
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const alpha = sw / (2 * Q)
  const b0 = (1 + cw) / 2
  const b1 = -(1 + cw)
  const b2 = (1 + cw) / 2
  const a0 = 1 + alpha
  const a1 = -2 * cw
  const a2 = 1 - alpha
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

function biquad(x: Float32Array, c: Biquad): Float32Array {
  const [b0, b1, b2, a1, a2] = c
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xn = x[i]
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = xn; y2 = y1; y1 = yn
    y[i] = yn
  }
  return y
}

function kWeight(x: Float32Array, fs: number): Float32Array {
  return biquad(biquad(x, highShelf(fs)), highPass(fs))
}

const blockLoudness = (z: number): number => -0.691 + 10 * Math.log10(z)

/**
 * Integrated loudness in LUFS for up to two channels (L/R weighted 1.0 each;
 * a single channel is treated as mono). Returns −Infinity for silence or for
 * signals shorter than one 400 ms block.
 */
export function integratedLufs(channels: Float32Array[], fs: number): number {
  if (!channels.length || !channels[0]?.length) return -Infinity
  const chans = channels.slice(0, 2).map((c) => kWeight(c, fs))
  const blockSize = Math.round(0.4 * fs)
  const step = Math.round(0.1 * fs)
  const n = chans[0].length
  if (n < blockSize) return -Infinity

  // Mean-square energy z per 400 ms block, summed across channels (G = 1.0).
  const blocks: number[] = []
  for (let start = 0; start + blockSize <= n; start += step) {
    let z = 0
    for (const c of chans) {
      let s = 0
      for (let i = start; i < start + blockSize; i++) s += c[i] * c[i]
      z += s / blockSize
    }
    blocks.push(z)
  }
  if (!blocks.length) return -Infinity

  // Absolute gate at −70 LUFS.
  let gated = blocks.filter((z) => z > 0 && blockLoudness(z) >= -70)
  if (!gated.length) return -Infinity

  // Relative gate: 10 LU below the mean loudness of the absolute-gated blocks.
  const meanZ = gated.reduce((a, b) => a + b, 0) / gated.length
  const relThreshold = blockLoudness(meanZ) - 10
  gated = gated.filter((z) => z > 0 && blockLoudness(z) >= relThreshold)
  if (!gated.length) return -Infinity

  const finalMean = gated.reduce((a, b) => a + b, 0) / gated.length
  return blockLoudness(finalMean)
}

/** Gain (dB) needed to reach `targetLufs`, clamped to ±12 dB. 0 if unmeasurable. */
export function lufsGainDb(lufs: number, targetLufs = -14): number {
  if (!Number.isFinite(lufs)) return 0
  return Math.max(-12, Math.min(12, targetLufs - lufs))
}

// ── AudioBuffer wrappers (renderer only) ──────────────────────────────────────

/** Integrated LUFS of a decoded buffer (first two channels). */
export function computeIntegratedLufs(buffer: AudioBuffer): number {
  const chans: Float32Array[] = []
  for (let ch = 0; ch < Math.min(buffer.numberOfChannels, 2); ch++) {
    chans.push(buffer.getChannelData(ch).slice())
  }
  return integratedLufs(chans, buffer.sampleRate)
}

/** Convenience: measure a buffer and return the auto-gain dB to hit `targetLufs`. */
export function computeLufsGainDb(buffer: AudioBuffer, targetLufs = -14): number {
  return lufsGainDb(computeIntegratedLufs(buffer), targetLufs)
}
