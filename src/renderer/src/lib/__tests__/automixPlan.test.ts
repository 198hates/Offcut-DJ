import { describe, it, expect } from 'vitest'
import {
  transitionBarsForBand,
  barsToMs,
  smoothstep,
  crossfadeAt,
  xfadeForDeck,
  entryCueMs
} from '../automixPlan'
import type { CuePoint } from '@shared/types'

describe('transitionBarsForBand', () => {
  it('uses the full length for a clean auto blend', () => {
    expect(transitionBarsForBand('auto', 16)).toBe(16)
  })
  it('halves (min 8) for assisted', () => {
    expect(transitionBarsForBand('assisted', 16)).toBe(8)
    expect(transitionBarsForBand('assisted', 8)).toBe(8) // floor at 8
  })
  it('quick-cuts a handback', () => {
    expect(transitionBarsForBand('handback', 32)).toBe(4)
  })
})

describe('barsToMs', () => {
  it('computes 4/4 bar duration at a given bpm', () => {
    // 1 bar @ 120 BPM = 4 beats × 500ms = 2000ms
    expect(barsToMs(1, 120)).toBe(2000)
    expect(barsToMs(16, 120)).toBe(32000)
  })
  it('falls back to 128 BPM for a missing tempo', () => {
    expect(barsToMs(1, null)).toBeCloseTo(4 * (60000 / 128))
    expect(barsToMs(1, 0)).toBeCloseTo(4 * (60000 / 128))
  })
})

describe('smoothstep', () => {
  it('pins the ends and is symmetric at the midpoint', () => {
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(0.5)).toBeCloseTo(0.5)
  })
  it('clamps out-of-range input', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(2)).toBe(1)
  })
})

describe('crossfadeAt', () => {
  it('moves monotonically from fromX to toX', () => {
    expect(crossfadeAt(0, 1000, 0, 1)).toBe(0)
    expect(crossfadeAt(1000, 1000, 0, 1)).toBe(1)
    const mid = crossfadeAt(500, 1000, 0, 1)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
  it('sweeps B→A direction too', () => {
    expect(crossfadeAt(0, 1000, 1, 0)).toBe(1)
    expect(crossfadeAt(1000, 1000, 1, 0)).toBe(0)
  })
  it('returns the destination for a zero-length transition', () => {
    expect(crossfadeAt(0, 0, 0, 1)).toBe(1)
  })
})

describe('xfadeForDeck', () => {
  it('isolates A at 0 and B at 1', () => {
    expect(xfadeForDeck('A')).toBe(0)
    expect(xfadeForDeck('B')).toBe(1)
  })
})

describe('entryCueMs', () => {
  const cue = (label: string, positionMs: number): CuePoint => ({
    index: 0, type: 'hotcue', positionMs, color: '#000', label
  })

  it('returns 0 when there is no mix-in style cue', () => {
    expect(entryCueMs({ cuePoints: [cue('Drop', 30000)] })).toBe(0)
    expect(entryCueMs({ cuePoints: [] })).toBe(0)
  })
  it('finds a mix-in / intro cue', () => {
    expect(entryCueMs({ cuePoints: [cue('Drop', 30000), cue('Mix In', 8000)] })).toBe(8000)
    expect(entryCueMs({ cuePoints: [cue('Intro', 4000)] })).toBe(4000)
  })
})
