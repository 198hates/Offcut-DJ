import { describe, it, expect } from 'vitest'
import { toSegments } from '../index'

describe('toSegments (all-in-one → PhraseSegment)', () => {
  it('maps labels, converts seconds→ms, and sorts by start', () => {
    const out = toSegments({
      segments: [
        { start: 8, end: 16, label: 'chorus' },
        { start: 0, end: 8, label: 'intro' },
        { start: 16, end: 24, label: 'break' }, // → breakdown
      ]
    })
    expect(out.map((s) => s.label)).toEqual(['intro', 'chorus', 'breakdown'])
    expect(out[0]).toMatchObject({ startMs: 0, endMs: 8000, confidence: 0.8 })
  })

  it('folds inst/solo onto verse/bridge and drops unknown + empty segments', () => {
    const out = toSegments({
      segments: [
        { start: 0, end: 4, label: 'inst' },   // → verse
        { start: 4, end: 8, label: 'solo' },    // → bridge
        { start: 8, end: 12, label: 'wtf' },    // unknown → dropped
        { start: 12, end: 12, label: 'verse' }, // zero-length → dropped
      ]
    })
    expect(out.map((s) => s.label)).toEqual(['verse', 'bridge'])
  })

  it('handles empty / missing input', () => {
    expect(toSegments({})).toEqual([])
    expect(toSegments({ segments: [] })).toEqual([])
  })
})
