import { describe, it, expect } from 'vitest'
import { discover } from '../discover'
import { LineageStore } from '../store'
import type { DiscogsClient } from '../discogs'
import type { DeezerClient } from '../deezer'
import type { SoundCloudClient } from '../soundcloud'
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

// ── Versions & remixes OF THE SEED ITSELF (Discogs composition search) ─────────
const versionDiscogs = (): DiscogsClient =>
  ({
    searchRelease: async (_p: { artist?: string; track?: string }) => ({
      results: [
        { id: 11, title: 'Seed Artist - Seed Track', year: 2019 },
        { id: 12, title: 'Seed Artist - Seed Track (Club Mix)', year: 2020 }
      ]
    })
  }) as unknown as DiscogsClient

const remixSeed = (): Seed => ({ ...bareSeed(), title: 'Seed Track (Some Remix)' })

describe('discover — versions & remixes route', () => {
  it('surfaces other versions of the seed composition as a "version" branch', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(versionDiscogs(), store, remixSeed(), {})
    store.close()
    const dir = res.directions.find((d) => d.type === 'version')
    expect(dir).toBeDefined()
    expect(dir!.title).toBe('Remixes & versions')
    // Searches the composition ("Seed Track", remix suffix stripped); the seed's
    // own version is deduped, every other release of it is surfaced.
    expect(dir!.pool.map((c) => c.title).sort()).toEqual(['Seed Track', 'Seed Track (Club Mix)'])
    expect(dir!.pool[0].why).toContain('Seed Track')
  })

  it('surfaces owned versions of the seed from the library (by composition title)', async () => {
    const store = new LineageStore(':memory:')
    const lib = [
      { artist: 'Seed Artist', title: 'Seed Track (Owned Remix)' }, // same-artist version
      { artist: 'Bootlegger', title: 'Seed Track (Bootleg Edit)' }, // remixer-credited — still the same track
      { artist: 'Other Artist', title: 'A Different Song' } // different title — must NOT match
    ]
    store.loadLibrary(lib)
    const res = await discover(versionDiscogs(), store, remixSeed(), {}, { library: lib })
    store.close()
    const dir = res.directions.find((d) => d.type === 'version')!
    const owned = dir.pool.find((c) => c.title === 'Seed Track (Owned Remix)')
    expect(owned).toBeDefined()
    expect(owned!.owned).toBe(true)
    // Matched by composition title regardless of the credited artist.
    expect(dir.pool.some((c) => c.title === 'Seed Track (Bootleg Edit)')).toBe(true)
    expect(dir.pool.some((c) => c.title === 'A Different Song')).toBe(false)
  })

  it('includes Deezer versions of the composition, filtering out non-matches', async () => {
    const store = new LineageStore(':memory:')
    const deezerClient = {
      searchTracks: async () => [
        { artist: 'Seed Artist', title: 'Seed Track (Deezer Remix)' }, // a version
        { artist: 'Nope', title: 'Totally Different Song' } // not the same composition
      ],
      relatedArtistGroups: async () => [] // satisfies the sonic route
    } as unknown as DeezerClient
    const res = await discover(versionDiscogs(), store, remixSeed(), {}, { deezer: deezerClient })
    store.close()
    const dir = res.directions.find((d) => d.type === 'version')!
    expect(dir.pool.some((c) => c.title === 'Seed Track (Deezer Remix)')).toBe(true)
    expect(dir.pool.some((c) => c.title === 'Totally Different Song')).toBe(false)
  })

  it('is skipped when its route type is filtered out', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(versionDiscogs(), store, remixSeed(), { filters: { routes: ['deezer'] } })
    store.close()
    expect(res.directions.find((d) => d.type === 'version')).toBeUndefined()
  })
})

// ── SoundCloud route (related tracks + versions-route source) ──────────────────
const fakeSoundcloud = (): SoundCloudClient =>
  ({
    relatedTracks: async () => [
      { artist: 'SC Artist', title: 'Underground Edit' },
      { artist: 'SC Artist 2', title: 'Bootleg Flip' }
    ],
    searchTracks: async () => [
      { artist: 'Seed Artist', title: 'Seed Track (SC Edit)' }, // a version of the seed
      { artist: 'Random', title: 'Unrelated Track' }
    ]
  }) as unknown as SoundCloudClient

describe('discover — SoundCloud route', () => {
  it('adds a SoundCloud branch from related tracks', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(versionDiscogs(), store, remixSeed(), {}, { soundcloud: fakeSoundcloud() })
    store.close()
    const dir = res.directions.find((d) => d.type === 'soundcloud')
    expect(dir).toBeDefined()
    expect(dir!.title).toBe('SOUNDCLOUD')
    expect(dir!.pool.map((c) => c.title)).toContain('Underground Edit')
  })

  it('folds SoundCloud versions of the composition into the version branch', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(versionDiscogs(), store, remixSeed(), {}, { soundcloud: fakeSoundcloud() })
    store.close()
    const ver = res.directions.find((d) => d.type === 'version')!
    expect(ver.pool.some((c) => c.title === 'Seed Track (SC Edit)')).toBe(true)
    expect(ver.pool.some((c) => c.title === 'Unrelated Track')).toBe(false)
  })
})

// ── Content-aware label branch (label → artists → tracks) ─────────────────────
const labelSeed = (): Seed => ({ ...bareSeed(), labels: [{ id: 5, name: 'Testone Records' }] })

const labelDiscogs = (): DiscogsClient =>
  ({
    searchRelease: async () => ({ results: [] }),
    getLabel: async () => ({ sublabels: [] }),
    getLabelReleases: async () => ({
      releases: [
        { id: 1, artist: 'Alpha', title: 'Track A1', year: 2020 },
        { id: 2, artist: 'Alpha', title: 'Track A2', year: 2021 },
        { id: 3, artist: 'Beta', title: 'Track B1', year: 2019 }
      ]
    })
  }) as unknown as DiscogsClient

describe('discover — content-aware label branch', () => {
  it('expands a label into artist entities, each carrying its tracks', async () => {
    const store = new LineageStore(':memory:')
    const res = await discover(labelDiscogs(), store, labelSeed(), {})
    store.close()
    const dir = res.directions.find((d) => d.type === 'label')!
    expect(dir).toBeDefined()
    // The branch pools ARTISTS (navigational entities), not tracks.
    expect(dir.pool.length).toBe(2)
    expect(dir.pool.every((c) => c.entity === 'artist' && c.title === '')).toBe(true)
    const alpha = dir.pool.find((c) => c.artist === 'Alpha')!
    const beta = dir.pool.find((c) => c.artist === 'Beta')!
    expect(alpha.children!.map((c) => c.title).sort()).toEqual(['Track A1', 'Track A2'])
    expect(beta.children!.map((c) => c.title)).toEqual(['Track B1'])
    expect(alpha.why).toContain('Testone Records')
  })
})
