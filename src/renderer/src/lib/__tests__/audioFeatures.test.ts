import { describe, it, expect } from 'vitest'
import { audioFeatureVector, FEATURE_DIM } from '@shared/audioFeatures'
import { findSimilar } from '../similarity'

const FS = 44100

function tone(freq: number, secs = 4, fs = FS): Float32Array {
  const n = Math.round(secs * fs)
  const out = new Float32Array(n)
  const w = (2 * Math.PI * freq) / fs
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin(w * i)
  return out
}

function noise(secs = 4, fs = FS): Float32Array {
  const n = Math.round(secs * fs)
  const out = new Float32Array(n)
  let s = 12345
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = (s / 0x3fffffff - 1) * 0.4 }
  return out
}

describe('audioFeatureVector', () => {
  it('returns a fixed-length finite vector', () => {
    const v = audioFeatureVector(tone(440), FS)
    expect(v).toHaveLength(FEATURE_DIM)
    expect(v.every((x) => Number.isFinite(x))).toBe(true)
  })

  it('a bright tone has a higher spectral centroid than a dark tone', () => {
    const dark = audioFeatureVector(tone(150), FS)
    const bright = audioFeatureVector(tone(6000), FS)
    // centroid is the 5th-from-last dim (…, centroid, rolloff, flat, bw, zcr)
    const ci = FEATURE_DIM - 5
    expect(bright[ci]).toBeGreaterThan(dark[ci])
  })
})

describe('findSimilar (content ranking)', () => {
  it('ranks a same-pitch tone above a detuned tone above noise', () => {
    const query = audioFeatureVector(tone(440), FS)
    const candidates = [
      { item: 'noise', vec: audioFeatureVector(noise(), FS) },
      { item: 'far', vec: audioFeatureVector(tone(3000), FS) },
      { item: 'near', vec: audioFeatureVector(tone(450), FS) }, // ~same as query
    ]
    const ranked = findSimilar(query, candidates, 3)
    expect(ranked[0].item).toBe('near')
    expect(ranked[ranked.length - 1].item).toBe('noise')
    expect(ranked[0].score).toBeGreaterThan(ranked[2].score)
  })

  it('handles empty / mismatched inputs gracefully', () => {
    expect(findSimilar([], [], 5)).toEqual([])
    const q = audioFeatureVector(tone(440), FS)
    expect(findSimilar(q, [{ item: 'x', vec: [1, 2, 3] }], 5)).toEqual([]) // wrong dim filtered out
  })
})
