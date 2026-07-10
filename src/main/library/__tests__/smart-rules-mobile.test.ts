// Tests the MOBILE smart-rule evaluator (apps/mobile/src/smartRules.ts) directly
// — it's pure logic with type-only imports, so vitest can exercise it here. This
// guards the in-memory port against the desktop SQL evaluator's semantics.
//
// Requires `apps/mobile/node_modules` to exist (run `npm install` there once —
// see apps/mobile/README.md). apps/mobile is an isolated npm project, so a root
// `npm install` alone won't fetch it. Without it, vitest's oxc transform can't
// resolve apps/mobile/tsconfig.json's `extends: "expo/tsconfig.base"` and this
// file fails to load with a cryptic "[TSCONFIG_ERROR] Tsconfig not found".

import { describe, it, expect } from 'vitest'
import { matchesAllRules, playlistTracks } from '../../../../apps/mobile/src/smartRules'

type AnyTrack = Record<string, unknown>
const t = (o: AnyTrack): any => ({ tags: [], customTags: {}, trackIds: [], ...o })

describe('smart-rule matcher (mobile)', () => {
  it('empty rules match everything', () => {
    expect(matchesAllRules(t({ title: 'x' }), [])).toBe(true)
  })

  it('string contains / is are case-insensitive', () => {
    const tr = t({ artist: 'Peggy Gou' })
    expect(matchesAllRules(tr, [{ field: 'artist', op: 'contains', value: 'gou' }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'artist', op: 'is', value: 'peggy gou' }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'artist', op: 'not_contains', value: 'gou' }])).toBe(false)
  })

  it('numeric between / greater_than / less_than', () => {
    const tr = t({ bpm: 127, rating: 5, energy: 8 })
    expect(matchesAllRules(tr, [{ field: 'bpm', op: 'between', value: [124, 130] }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'bpm', op: 'between', value: [130, 140] }])).toBe(false)
    expect(matchesAllRules(tr, [{ field: 'rating', op: 'greater_than', value: 4 }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'energy', op: 'less_than', value: 8 }])).toBe(false)
  })

  it('tags = exact membership (case-insensitive)', () => {
    const tr = t({ tags: ['Peak Time', 'Vocal'] })
    expect(matchesAllRules(tr, [{ field: 'tags', op: 'contains', value: 'peak time' }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'tags', op: 'contains', value: 'peak' }])).toBe(false) // exact, not substring
    expect(matchesAllRules(tr, [{ field: 'tags', op: 'not_contains', value: 'acoustic' }])).toBe(true)
  })

  it('customTag matches per key', () => {
    const tr = t({ customTags: { vibe: 'sunset' } })
    expect(matchesAllRules(tr, [{ field: 'customTag', op: 'is', value: 'sunset', customTagKey: 'vibe' }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'customTag', op: 'contains', value: 'sun', customTagKey: 'vibe' }])).toBe(true)
    expect(matchesAllRules(tr, [{ field: 'customTag', op: 'is_not', value: 'sunset', customTagKey: 'missing' }])).toBe(true)
  })

  it('in_last_days on dateAdded', () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    expect(matchesAllRules(t({ dateAdded: recent }), [{ field: 'dateAdded', op: 'in_last_days', value: 7 }])).toBe(true)
    expect(matchesAllRules(t({ dateAdded: old }), [{ field: 'dateAdded', op: 'in_last_days', value: 7 }])).toBe(false)
  })

  it('a null field fails every comparison (mirrors SQL NULL)', () => {
    expect(matchesAllRules(t({ energy: null }), [{ field: 'energy', op: 'greater_than', value: 5 }])).toBe(false)
    expect(matchesAllRules(t({ genre: null }), [{ field: 'genre', op: 'is_not', value: 'house' }])).toBe(false)
  })

  it('rules are AND-combined', () => {
    const tr = t({ bpm: 127, key: '8A', rating: 5 })
    const rules = [
      { field: 'bpm' as const, op: 'between' as const, value: [124, 130] as [number, number] },
      { field: 'rating' as const, op: 'greater_than' as const, value: 4 }
    ]
    expect(matchesAllRules(tr, rules)).toBe(true)
    expect(matchesAllRules({ ...tr, rating: 3 }, rules)).toBe(false)
  })

  it('playlistTracks resolves a smartlist and falls back to membership otherwise', () => {
    const tracks = [t({ id: 'a', artist: 'Gou', bpm: 127 }), t({ id: 'b', artist: 'Kink', bpm: 140 })]
    const byId = new Map(tracks.map((x) => [x.id as string, x]))
    const smart = { id: 's', isSmart: true, rules: [{ field: 'bpm', op: 'less_than', value: 130 }], trackIds: [] } as any
    const manual = { id: 'm', isSmart: false, rules: [], trackIds: ['b'] } as any
    expect(playlistTracks(smart, tracks, byId).map((x) => x.id)).toEqual(['a'])
    expect(playlistTracks(manual, tracks, byId).map((x) => x.id)).toEqual(['b'])
  })
})
