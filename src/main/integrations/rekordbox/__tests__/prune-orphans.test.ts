import { describe, it, expect } from 'vitest'
import {
  planOrphanPrune,
  type RekordboxRow,
  type PlaylistMembership,
  type Replacements
} from '../prune-orphans'

const row = (over: Partial<RekordboxRow> & { ID: string }): RekordboxRow => ({
  FolderPath: `/Music/${over.ID}.mp3`,
  Title: 'Song',
  FileSize: 1000,
  ...over
})

const pairs = (m: Record<string, string>): Replacements => new Map(Object.entries(m))
const member = (m: Record<string, string[]>): PlaylistMembership =>
  new Map(Object.entries(m).map(([id, pls]) => [id, new Set(pls)]))

/** The ordinary case: 'dupe' was resolved in favour of 'keep'. */
const ROWS = [row({ ID: 'keep' }), row({ ID: 'dupe' })]
const LIVE = new Set(['keep'])

describe('planOrphanPrune', () => {
  it('retires a row a resolved duplicate recorded as replaced', () => {
    const d = planOrphanPrune(ROWS, LIVE, pairs({ dupe: 'keep' }), member({}))
    expect(d.prunable).toEqual(['dupe'])
    expect(d.blocked).toEqual([])
  })

  it('retires nothing without a recorded pairing, however dead the row looks', () => {
    /* The whole safety model. Nothing is inferred from a missing file, so the
       unmounted-drive case — a whole volume unreachable, every track apparently
       gone — cannot produce a single deletion, because it produces no pairings. */
    const unplugged = [
      row({ ID: 'a', FolderPath: '/Volumes/USB/a.mp3' }),
      row({ ID: 'b', FolderPath: '/Volumes/USB/b.mp3' })
    ]
    expect(planOrphanPrune(unplugged, new Set(), pairs({}), member({})).prunable).toEqual([])
  })

  it('never retires a row Offcut still tracks', () => {
    // A stale pairing plus a live row is a relink, not a deletion.
    const d = planOrphanPrune(ROWS, new Set(['keep', 'dupe']), pairs({ dupe: 'keep' }), member({}))
    expect(d.prunable).toEqual([])
  })

  it('holds back when the keeper has no rekordbox row of its own', () => {
    // The keeper was imported from a folder: it cannot stand in for anything here.
    const d = planOrphanPrune(ROWS, LIVE, pairs({ dupe: 'not-in-rekordbox' }), member({}))
    expect(d.prunable).toEqual([])
    expect(d.blocked).toEqual([{ removedId: 'dupe', reason: 'keeper-not-in-rekordbox' }])
  })

  it('holds back when rekordbox has the keeper but Offcut has dropped it', () => {
    const d = planOrphanPrune(ROWS, new Set(), pairs({ dupe: 'keep' }), member({}))
    expect(d.blocked).toEqual([{ removedId: 'dupe', reason: 'keeper-not-in-rekordbox' }])
  })

  it('retires the row once the keeper is in every playlist it was in', () => {
    // What the export's writeback produces before this runs.
    const m = member({ dupe: ['p1', 'p2'], keep: ['p1', 'p2'] })
    expect(planOrphanPrune(ROWS, LIVE, pairs({ dupe: 'keep' }), m).prunable).toEqual(['dupe'])
  })

  it('holds back when the keeper is missing from one of those playlists', () => {
    // p2 would silently lose the track — leave the dead row visible instead.
    const m = member({ dupe: ['p1', 'p2'], keep: ['p1'] })
    const d = planOrphanPrune(ROWS, LIVE, pairs({ dupe: 'keep' }), m)
    expect(d.prunable).toEqual([])
    expect(d.blocked).toEqual([{ removedId: 'dupe', reason: 'playlist-not-covered' }])
  })

  it('retires a row that was in no playlist at all', () => {
    const m = member({ keep: ['p1'] })
    expect(planOrphanPrune(ROWS, LIVE, pairs({ dupe: 'keep' }), m).prunable).toEqual(['dupe'])
  })

  it('handles several copies resolved onto one keeper', () => {
    const rows = [row({ ID: 'keep' }), row({ ID: 'd1' }), row({ ID: 'd2' }), row({ ID: 'd3' })]
    const repl = pairs({ d1: 'keep', d2: 'keep', d3: 'keep' })
    const m = member({ d1: ['p1'], d2: ['p1'], d3: ['p2'], keep: ['p1', 'p2'] })
    expect(planOrphanPrune(rows, LIVE, repl, m).prunable).toEqual(['d1', 'd2', 'd3'])
  })

  it('reports each blocked pairing separately so the count is actionable', () => {
    const rows = [row({ ID: 'keep' }), row({ ID: 'd1' }), row({ ID: 'd2' })]
    const m = member({ d1: ['p1'], keep: [] })
    const d = planOrphanPrune(rows, LIVE, pairs({ d1: 'keep', d2: 'ghost' }), m)
    expect(d.prunable).toEqual([])
    expect(d.blocked).toEqual([
      { removedId: 'd1', reason: 'playlist-not-covered' },
      { removedId: 'd2', reason: 'keeper-not-in-rekordbox' }
    ])
  })

  it('is a no-op on a healthy library with nothing recorded', () => {
    expect(planOrphanPrune(ROWS, new Set(['keep', 'dupe']), pairs({}), member({})).prunable).toEqual([])
  })

  it('ignores a pairing for a row rekordbox no longer has', () => {
    // Already retired by an earlier sync: there is nothing left to act on.
    expect(planOrphanPrune([row({ ID: 'keep' })], LIVE, pairs({ gone: 'keep' }), member({})).prunable)
      .toEqual([])
  })
})
