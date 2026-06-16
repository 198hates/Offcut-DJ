import { describe, it, expect } from 'vitest'
import {
  transitionBarsForBand,
  barsToMs,
  smoothstep,
  crossfadeAt,
  xfadeForDeck,
  entryCueMs,
  pickNextTrack
} from '../automixPlan'
import type { CuePoint, Track } from '@shared/types'

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

describe('pickNextTrack', () => {
  // scoreTransition reads id/bpm/key/energy (+ optional grid); a partial is enough.
  const t = (id: string, bpm: number | null, key: string, energy: number): Track =>
    ({ id, bpm, key, energy } as unknown as Track)

  const current = t('cur', 128, '8A', 5)

  it('picks the most compatible candidate (same key + tempo)', () => {
    const pool = [
      t('far', 150, '3B', 9), // distant key + big tempo gap
      t('match', 128, '8A', 5), // same key, same bpm, same energy → best
      t('close', 129, '9A', 6) // adjacent key, near tempo
    ]
    expect(pickNextTrack(current, pool, new Set())?.id).toBe('match')
  })

  it('skips the current track, already-played tracks, and gridless (no-bpm) tracks', () => {
    const pool = [
      current, // self
      t('played', 128, '8A', 5), // best on paper but already played
      t('nobpm', null, '8A', 5), // no tempo → unusable
      t('ok', 127, '8A', 5)
    ]
    expect(pickNextTrack(current, pool, new Set(['played']))?.id).toBe('ok')
  })

  it('returns null when the pool is exhausted', () => {
    expect(pickNextTrack(current, [current], new Set())).toBeNull()
    expect(pickNextTrack(current, [], new Set())).toBeNull()
  })
})
