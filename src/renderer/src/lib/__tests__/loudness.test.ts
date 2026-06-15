import { describe, it, expect } from 'vitest'
import { integratedLufs, lufsGainDb } from '../loudness'

const FS = 48000

/** A `seconds`-long 1 kHz sine at the given linear amplitude. */
function sine(amp: number, seconds = 3, freq = 1000, fs = FS): Float32Array {
  const n = Math.round(seconds * fs)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * freq) / fs
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i)
  return out
}

describe('integratedLufs (BS.1770)', () => {
  it('is monotonic with level', () => {
    const loud = integratedLufs([sine(0.5)], FS)
    const quiet = integratedLufs([sine(0.05)], FS)
    expect(loud).toBeGreaterThan(quiet)
  })

  it('is linear in dB — a −20 dB drop reads ~20 LU lower', () => {
    const a = integratedLufs([sine(0.5)], FS)
    const b = integratedLufs([sine(0.05)], FS) // 0.05/0.5 = −20 dB
    expect(a - b).toBeGreaterThan(19.5)
    expect(a - b).toBeLessThan(20.5)
  })

  it('produces a finite, plausible value for a full-scale tone', () => {
    const l = integratedLufs([sine(1.0)], FS)
    expect(Number.isFinite(l)).toBe(true)
    expect(l).toBeGreaterThan(-12)
    expect(l).toBeLessThan(6)
  })

  it('stereo (two identical channels) reads ~3 LU louder than mono', () => {
    const mono = integratedLufs([sine(0.3)], FS)
    const stereo = integratedLufs([sine(0.3), sine(0.3)], FS)
    expect(stereo - mono).toBeGreaterThan(2.5)
    expect(stereo - mono).toBeLessThan(3.5)
  })

  it('works at 44.1 kHz (filters recomputed per sample rate)', () => {
    const l = integratedLufs([sine(0.5, 3, 1000, 44100)], 44100)
    expect(Number.isFinite(l)).toBe(true)
  })

  it('returns −Infinity for silence and for sub-block signals', () => {
    expect(integratedLufs([new Float32Array(FS * 2)], FS)).toBe(-Infinity)
    expect(integratedLufs([sine(0.5, 0.1)], FS)).toBe(-Infinity) // 100 ms < 400 ms block
    expect(integratedLufs([], FS)).toBe(-Infinity)
  })
})

describe('lufsGainDb', () => {
  it('returns target − measured, clamped to ±12 dB', () => {
    expect(lufsGainDb(-20, -14)).toBeCloseTo(6, 5)
    expect(lufsGainDb(-8, -14)).toBeCloseTo(-6, 5)
    expect(lufsGainDb(-40, -14)).toBe(12) // clamp
    expect(lufsGainDb(10, -14)).toBe(-12) // clamp
  })

  it('returns 0 when loudness is unmeasurable', () => {
    expect(lufsGainDb(-Infinity)).toBe(0)
    expect(lufsGainDb(NaN)).toBe(0)
  })
})
