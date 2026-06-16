import { describe, it, expect } from 'vitest'
import { dedupeAcrossDirections } from '../discover'
import type { Candidate, Direction } from '../types'

const cand = (key: string, score: number): Candidate => ({
  key,
  artist: key,
  title: key,
  label: null,
  year: null,
  discogs_id: null,
  why: '',
  score
})

const dir = (id: string, pool: Candidate[]): Direction => ({
  id,
  type: 'label',
  title: id,
  pool
})

describe('dedupeAcrossDirections', () => {
  it('keeps a shared track only in its strongest branch', () => {
    const strong = dir('strong', [cand('a', 90), cand('shared', 80)])
    const weak = dir('weak', [cand('shared', 50), cand('b', 40)])
    dedupeAcrossDirections([strong, weak])
    expect(strong.pool.map((c) => c.key)).toEqual(['a', 'shared'])
    expect(weak.pool.map((c) => c.key)).toEqual(['b']) // 'shared' claimed by strong
  })

  it('is deterministic regardless of array order (branch strength wins)', () => {
    const a = dir('a', [cand('x', 70), cand('dup', 65)])
    const b = dir('b', [cand('y', 95), cand('dup', 60)])
    dedupeAcrossDirections([a, b]) // b is stronger by top score
    expect(b.pool.map((c) => c.key)).toEqual(['y', 'dup'])
    expect(a.pool.map((c) => c.key)).toEqual(['x'])
  })

  it('can empty a weaker branch entirely', () => {
    const strong = dir('strong', [cand('a', 90), cand('b', 85)])
    const weak = dir('weak', [cand('a', 50), cand('b', 45)])
    dedupeAcrossDirections([strong, weak])
    expect(weak.pool).toEqual([])
  })

  it('breaks score ties by branch id for stable output', () => {
    const z = dir('z', [cand('dup', 50)])
    const a = dir('a', [cand('dup', 50)])
    dedupeAcrossDirections([z, a]) // equal top score → 'a' wins by id
    expect(a.pool.map((c) => c.key)).toEqual(['dup'])
    expect(z.pool).toEqual([])
  })
})
