import { describe, it, expect } from 'vitest'
import {
  sampleToMs,
  engineKeyToName,
  nameToEngineKey,
  engineRatingToStars,
  starsToEngineRating,
  engineColorToHex,
} from '../reader'

// ── sampleToMs ──────────────────────────────────────────────────────────────
//
// Engine DJ stores cue/loop positions in SAMPLES at the track's native sample
// rate (documented: the rate lives in the PerformanceData trackData/beatData
// blobs; 44100 is common, 48000 "makes an appearance on occasion").
// reader.ts currently hardcodes 44100. These tests pin the arithmetic and
// demonstrate the error that hardcoding introduces for 48 kHz tracks.

describe('sampleToMs', () => {
  it('converts samples to milliseconds at 44.1 kHz', () => {
    expect(sampleToMs(44100, 44100)).toBe(1000)
    expect(sampleToMs(22050, 44100)).toBe(500)
    expect(sampleToMs(0, 44100)).toBe(0)
  })

  it('converts correctly at 48 kHz when the real rate is passed', () => {
    expect(sampleToMs(48000, 48000)).toBe(1000)
    expect(sampleToMs(24000, 48000)).toBe(500)
  })

  it('rounds to the nearest millisecond', () => {
    // 100 samples @ 44100 = 2.2675…ms → 2ms
    expect(sampleToMs(100, 44100)).toBe(2)
  })

  it('defaults to 44100 — which is WRONG for a 48 kHz track', () => {
    // A cue at exactly 1.000s on a 48 kHz track sits at sample 48000.
    // Decoded with the 44100 default it reads as ~1088ms — ~8.8% late.
    const trueMs = sampleToMs(48000, 48000) // 1000
    const decodedWithDefault = sampleToMs(48000) // assumes 44100
    expect(trueMs).toBe(1000)
    expect(decodedWithDefault).toBe(1088)
    // Guards the bug: until reader.ts passes the track's real rate, 48 kHz
    // cues drift by this margin. This test should be revisited when the
    // sample-rate source column is confirmed against a real m.db.
    expect(decodedWithDefault).not.toBe(trueMs)
  })
})

// ── Key mapping ───────────────────────────────────────────────────────────────
//
// IMPORTANT: the absolute key-number → key-name mapping below is UNVERIFIED
// against a real Engine Library m.db. reader.ts assumes Camelot order
// (1-12 = nA minor, 13-24 = nB major, 0 = unknown). The Mixxx reverse-
// engineering wiki documents a DIFFERENT, CHROMATIC-by-pitch-class encoding
// (0-23, where 0 = C major) for the older Engine Prime schema. These tests
// therefore assert two things separately:
//   1. The SELF-CONSISTENCY invariant (import is the inverse of export) — this
//      holds regardless of which absolute mapping is correct, and is what makes
//      Offcut↔Engine round-tripping safe.
//   2. The CURRENT documented behaviour of reader.ts — pinned so any future
//      correction to the mapping is a deliberate, visible change.

describe('Engine key mapping — self-consistency invariant (mapping-agnostic)', () => {
  it('nameToEngineKey is the inverse of engineKeyToName for every code point', () => {
    for (let k = 1; k <= 24; k++) {
      const name = engineKeyToName(k)
      expect(name).not.toBeNull()
      expect(nameToEngineKey(name)).toBe(k)
    }
  })

  it('round-trips every Camelot name back to itself', () => {
    const names = [
      '1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A',
      '1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B',
    ]
    for (const name of names) {
      expect(engineKeyToName(nameToEngineKey(name))).toBe(name)
    }
  })
})

describe('Engine key mapping — CURRENT behaviour (Camelot assumption, UNVERIFIED)', () => {
  it('treats 1-12 as minor (A) keys', () => {
    expect(engineKeyToName(1)).toBe('1A')
    expect(engineKeyToName(12)).toBe('12A')
  })

  it('treats 13-24 as major (B) keys', () => {
    expect(engineKeyToName(13)).toBe('1B')
    expect(engineKeyToName(24)).toBe('12B')
  })

  it('treats 0 and null as no key (NOTE: Mixxx docs say 0 = C major)', () => {
    expect(engineKeyToName(0)).toBeNull()
    expect(engineKeyToName(null)).toBeNull()
  })

  it('returns null for out-of-range values', () => {
    expect(engineKeyToName(25)).toBeNull()
    expect(engineKeyToName(-1)).toBeNull()
  })

  it('maps unknown names to null on export', () => {
    expect(nameToEngineKey(null)).toBeNull()
    expect(nameToEngineKey('')).toBeNull()
    expect(nameToEngineKey('Cmaj')).toBeNull()
    expect(nameToEngineKey('13A')).toBeNull()
  })
})

// ── Rating mapping ──────────────────────────────────────────────────────────
// Engine stores rating 0-100; Offcut uses 0-5 stars.

describe('Engine rating mapping', () => {
  it('converts Engine 0-100 to 0-5 stars', () => {
    expect(engineRatingToStars(0)).toBe(0)
    expect(engineRatingToStars(null)).toBe(0)
    expect(engineRatingToStars(100)).toBe(5)
    expect(engineRatingToStars(60)).toBe(3)
  })

  it('converts 0-5 stars back to Engine 0-100', () => {
    expect(starsToEngineRating(0)).toBe(0)
    expect(starsToEngineRating(5)).toBe(100)
    expect(starsToEngineRating(3)).toBe(60)
  })

  it('round-trips the discrete star values', () => {
    for (let stars = 0; stars <= 5; stars++) {
      expect(engineRatingToStars(starsToEngineRating(stars))).toBe(stars)
    }
  })
})

// ── Colour mapping ────────────────────────────────────────────────────────────

describe('Engine colour mapping', () => {
  it('decodes a packed 0xRRGGBB integer to a hex string', () => {
    expect(engineColorToHex(0xff0000)).toBe('#ff0000')
    expect(engineColorToHex(0x00ff00)).toBe('#00ff00')
    expect(engineColorToHex(0x0000ff)).toBe('#0000ff')
  })

  it('falls back to orange for 0/null', () => {
    expect(engineColorToHex(0)).toBe('#ff8c00')
    expect(engineColorToHex(null)).toBe('#ff8c00')
  })

  it('zero-pads single-digit channels', () => {
    expect(engineColorToHex(0x010203)).toBe('#010203')
  })
})
