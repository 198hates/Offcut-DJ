/**
 * Regression cover for the duplicate-detection comparison.
 *
 * The bug this locks down: the Health duplicate scanner compared feature vectors
 * with a plain cosine over all 43 dimensions. MFCC coefficient 0 is log frame
 * energy, so it tracks loudness and dominates the vector's magnitude — two copies
 * of one track differing by 1 dB scored 0.9940 and were missed at a 0.995
 * threshold, while unrelated tracks of similar level scored 0.9998 and were
 * flagged. Dropping that one dimension separates the two populations cleanly.
 *
 * These tests assert the property that matters (gain invariance, with distinct
 * audio still kept apart) rather than exact scores, so a future change of feature
 * layout or threshold has to keep the behaviour, not the numbers.
 */
import { describe, it, expect } from 'vitest'
import { audioFeatureVector } from '@shared/audioFeatures'
import { duplicateMatch, DUPLICATE_MATCH_THRESHOLD } from '../similarity'

const FS = 22050
const SECS = 20

let seed = 4242
const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5

/** A synthetic "track": kick at `root`, its harmonics, and some hats. */
function synth(root: number, tempo: number, bright: number): Float32Array {
  const n = Math.round(SECS * FS)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / FS
    const kick = Math.sin(2 * Math.PI * root * t) * Math.exp(-8 * ((t * tempo) % 1))
    const harm = Math.sin(2 * Math.PI * root * 3 * t) * 0.3 + Math.sin(2 * Math.PI * root * 5 * t) * 0.15
    const hats = rnd() * bright * (1 + Math.sin(2 * Math.PI * 7000 * t))
    out[i] = 0.4 * kick + 0.15 * harm + hats + rnd() * 0.02
  }
  return out
}

const gained = (src: Float32Array, g: number): Float32Array => {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i] * g
  return out
}

const dithered = (src: Float32Array): Float32Array => {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i] + rnd() * 0.001
  return out
}

const vec = (pcm: Float32Array): number[] => audioFeatureVector(pcm, FS)

describe('duplicateMatch', () => {
  const trackA = synth(55, 2, 0.05)
  const vecA = vec(trackA)

  it('scores an identical vector at 1', () => {
    expect(duplicateMatch(vecA, vecA)).toBeCloseTo(1, 6)
  })

  it('still matches the same audio after a re-encode-scale perturbation', () => {
    expect(duplicateMatch(vecA, vec(dithered(trackA)))).toBeGreaterThanOrEqual(
      DUPLICATE_MATCH_THRESHOLD
    )
  })

  // The headline regression. -1 dB is the case that used to fail; the louder
  // drops are what a normalised rip or a different master really looks like.
  it.each([
    ['-1 dB', 0.891],
    ['-3 dB', 0.708],
    ['-6 dB', 0.501],
    ['-12 dB', 0.251]
  ])('matches the same audio at %s', (_label, g) => {
    expect(duplicateMatch(vecA, vec(gained(trackA, g)))).toBeGreaterThanOrEqual(
      DUPLICATE_MATCH_THRESHOLD
    )
  })

  it('keeps genuinely different tracks below the threshold, at any level', () => {
    const others = [synth(82, 2.4, 0.5), synth(98, 1.6, 0.35), synth(65, 2.1, 0.7)]
    for (const other of others) {
      for (const g of [1, 0.708, 0.251]) {
        expect(duplicateMatch(vecA, vec(gained(other, g)))).toBeLessThan(
          DUPLICATE_MATCH_THRESHOLD
        )
      }
    }
  })

  it('is symmetric and ignores loudness, so gain cannot change a verdict', () => {
    const quiet = vec(gained(trackA, 0.501))
    expect(duplicateMatch(vecA, quiet)).toBeCloseTo(duplicateMatch(quiet, vecA), 12)
  })

  it('returns 0 rather than throwing on missing or mismatched vectors', () => {
    expect(duplicateMatch([], vecA)).toBe(0)
    expect(duplicateMatch(vecA, vecA.slice(0, 10))).toBe(0)
  })
})
