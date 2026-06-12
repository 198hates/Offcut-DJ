import { describe, it, expect } from 'vitest'
import {
  isCamelot,
  rbScaleNameToCamelot,
  traktorValueToCamelot,
  camelotToTraktorValue,
} from '../key-notation'

const CAMELOT_RE = /^(\d{1,2})([AB])$/ // the renderer's harmonic parser

describe('rbScaleNameToCamelot', () => {
  it('maps rekordbox scale names to Camelot', () => {
    expect(rbScaleNameToCamelot('Cmaj')).toBe('8B')
    expect(rbScaleNameToCamelot('Amin')).toBe('8A')
    expect(rbScaleNameToCamelot('Bmaj')).toBe('1B')
    expect(rbScaleNameToCamelot('Gmin')).toBe('6A')
  })

  it('treats enharmonic equivalents the same (Db == C#)', () => {
    expect(rbScaleNameToCamelot('Dbmaj')).toBe(rbScaleNameToCamelot('C#maj'))
  })

  it('passes through an already-Camelot value', () => {
    expect(rbScaleNameToCamelot('8B')).toBe('8B')
    expect(rbScaleNameToCamelot('1a')).toBe('1A')
  })

  it('returns null for null/blank/unknown', () => {
    expect(rbScaleNameToCamelot(null)).toBeNull()
    expect(rbScaleNameToCamelot('')).toBeNull()
    expect(rbScaleNameToCamelot('nonsense')).toBeNull()
  })

  it('every output is parseable by the harmonic regex', () => {
    for (const name of ['Cmaj', 'Amin', 'F#maj', 'Bbmin']) {
      expect(CAMELOT_RE.test(rbScaleNameToCamelot(name)!)).toBe(true)
    }
  })
})

describe('traktorValueToCamelot', () => {
  it('anchors: 0 = C major = 8B, 12 = A minor = 8A', () => {
    expect(traktorValueToCamelot(0)).toBe('8B')
    expect(traktorValueToCamelot(12)).toBe('8A')
  })

  it('produces Camelot for every valid value 0..23', () => {
    for (let v = 0; v < 24; v++) {
      const cam = traktorValueToCamelot(v)
      expect(cam).not.toBeNull()
      expect(CAMELOT_RE.test(cam!)).toBe(true)
    }
  })

  it('returns null out of range / for null', () => {
    expect(traktorValueToCamelot(-1)).toBeNull()
    expect(traktorValueToCamelot(24)).toBeNull()
    expect(traktorValueToCamelot(null)).toBeNull()
  })
})

describe('Traktor value ↔ Camelot round-trip', () => {
  it('camelotToTraktorValue inverts traktorValueToCamelot for all 24 values', () => {
    for (let v = 0; v < 24; v++) {
      const cam = traktorValueToCamelot(v)!
      expect(camelotToTraktorValue(cam)).toBe(v)
    }
  })

  it('is case-insensitive on Camelot input', () => {
    expect(camelotToTraktorValue('8b')).toBe(camelotToTraktorValue('8B'))
  })

  it('returns null for non-Camelot input', () => {
    expect(camelotToTraktorValue('Cmaj')).toBeNull()
    expect(camelotToTraktorValue('13B')).toBeNull()
    expect(camelotToTraktorValue(null)).toBeNull()
  })
})

describe('cross-format consistency', () => {
  it('rekordbox and traktor agree on the same musical key', () => {
    // C major → 8B from both notations
    expect(rbScaleNameToCamelot('Cmaj')).toBe('8B')
    expect(traktorValueToCamelot(0)).toBe('8B')
    // A minor → 8A from both
    expect(rbScaleNameToCamelot('Amin')).toBe('8A')
    expect(traktorValueToCamelot(12)).toBe('8A')
  })
})

describe('isCamelot', () => {
  it('accepts valid codes and rejects others', () => {
    expect(isCamelot('8B')).toBe(true)
    expect(isCamelot('12a')).toBe(true)
    expect(isCamelot('Cmaj')).toBe(false)
    expect(isCamelot('1d')).toBe(false)
  })
})
