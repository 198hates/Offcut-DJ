import { describe, it, expect } from 'vitest'
import { discover } from '../discover'
import { LineageStore } from '../store'
import type { DiscogsClient } from '../discogs'
import type { DeezerClient } from '../deezer'
import type { Seed } from '../types'

// A seed with no Discogs credits, so the Discogs chain is a no-op and we isolate
// the keyless Deezer route + the owned-tagging behaviour.
const bareSeed = (): Seed => ({
  releaseId: null,
  artist: 'Seed Artist',
  title: 'Seed Track',
  year: 2020,
  labels: [],
  styles: [],
  genres: [],
  remixers: [],
  producers: [],
  artists: [],
  players: []
})

// Discogs is never hit for a credit-free seed; a bare stub satisfies the type.
const noDiscogs = {} as unknown as DiscogsClient

const fakeDeezer = (): DeezerClient =>
  ({
    relatedTracks: async () => [
      { artist: 'New Artist', title: 'New Song', weight: 1 },
      { artist: 'Owned Artist', title: 'Owned Song', weight: 0.5 }
    ]
  }) as unknown as DeezerClient

describe('discover — Deezer route + owned tagging', () => {
  it('surfaces a keyless Deezer "sounds like" branch', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(noDiscogs, store, bareSeed(), {}, { deezer: fakeDeezer() })
    store.close()
    const deezer = res.directions.find((d) => d.id === 'deezer')
    expect(deezer?.type).toBe('deezer')
    expect(deezer?.pool.map((c) => c.title)).toContain('New Song')
  })

  it('keeps owned tracks but tags + deranks them below new finds', async () => {
    const store = new LineageStore(':memory:')
    store.loadLibrary([{ artist: 'Owned Artist', title: 'Owned Song' }])
    const res = await discover(noDiscogs, store, bareSeed(), {}, { deezer: fakeDeezer() })
    store.close()

    const pool = res.directions.find((d) => d.id === 'deezer')!.pool
    const fresh = pool.find((c) => c.title === 'New Song')!
    const owned = pool.find((c) => c.title === 'Owned Song')!

    expect(owned.owned).toBe(true)
    expect(fresh.owned).toBeFalsy()
    // Owned track is surfaced (not dropped) but ranks below the new find.
    expect(fresh.score).toBeGreaterThan(owned.score)
    expect(pool.indexOf(fresh)).toBeLessThan(pool.indexOf(owned))
  })

  it('ranks owned tracks at full score when includeOwned is set', async () => {
    const store = new LineageStore(':memory:')
    store.loadLibrary([{ artist: 'Owned Artist', title: 'Owned Song' }])
    const res = await discover(
      noDiscogs,
      store,
      bareSeed(),
      { filters: { includeOwned: true } },
      { deezer: fakeDeezer() }
    )
    store.close()
    const owned = res.directions
      .find((d) => d.id === 'deezer')!
      .pool.find((c) => c.title === 'Owned Song')!
    // weight 0.5 -> 80 + round(0.5*8) = 84, with no owned penalty applied.
    expect(owned.owned).toBe(true)
    expect(owned.score).toBe(84)
  })
})
