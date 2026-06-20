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

// Two related artists, each their own sub-branch. "Near Artist" is closer
// (weight 1); "Far Artist" owns a track the user already has.
const fakeDeezer = (): DeezerClient =>
  ({
    relatedArtistGroups: async () => [
      { id: 1, name: 'Near Artist', weight: 1, tracks: [{ artist: 'Near Artist', title: 'New Song' }] },
      {
        id: 2,
        name: 'Far Artist',
        weight: 0.5,
        tracks: [
          { artist: 'Far Artist', title: 'Far Song' },
          { artist: 'Owned Artist', title: 'Owned Song' }
        ]
      }
    ]
  }) as unknown as DeezerClient

const deezerDirs = (res: { directions: { id: string }[] }): string[] =>
  res.directions.filter((d) => d.id.startsWith('deezer:')).map((d) => d.id)

describe('discover — Deezer route + owned tagging', () => {
  it('surfaces one keyless Deezer branch per related artist', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(noDiscogs, store, bareSeed(), {}, { deezer: fakeDeezer() })
    store.close()
    expect(deezerDirs(res).sort()).toEqual(['deezer:1', 'deezer:2'])
    const near = res.directions.find((d) => d.id === 'deezer:1')!
    expect(near.type).toBe('deezer')
    expect(near.title).toBe('Near Artist')
    expect(near.pool.map((c) => c.title)).toContain('New Song')
  })

  it('ranks the closer related artist above the further one', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(noDiscogs, store, bareSeed(), {}, { deezer: fakeDeezer() })
    store.close()
    const near = res.directions.find((d) => d.id === 'deezer:1')!
    const far = res.directions.find((d) => d.id === 'deezer:2')!
    expect(near.pool[0].score).toBeGreaterThan(far.pool[0].score)
  })

  it('keeps owned tracks but tags + deranks them below new finds', async () => {
    const store = new LineageStore(':memory:')
    store.loadLibrary([{ artist: 'Owned Artist', title: 'Owned Song' }])
    const res = await discover(noDiscogs, store, bareSeed(), {}, { deezer: fakeDeezer() })
    store.close()

    const pool = res.directions.find((d) => d.id === 'deezer:2')!.pool
    const fresh = pool.find((c) => c.title === 'Far Song')!
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
      .find((d) => d.id === 'deezer:2')!
      .pool.find((c) => c.title === 'Owned Song')!
    // weight 0.5 -> 80 + round(0.5*8) = 84, with no owned penalty applied.
    expect(owned.owned).toBe(true)
    expect(owned.score).toBe(84)
  })
})
