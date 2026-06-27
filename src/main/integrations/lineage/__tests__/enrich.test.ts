import { describe, it, expect } from 'vitest'
import { enrich, searchSeeds } from '../enrich'
import type { DiscogsClient } from '../discogs'

// Discogs returns the 1992 Various-Artists comp FIRST (its raw relevance), with
// Fisher's actual release second — the exact shape that mis-seeded the dig.
const mockDiscogs = (): DiscogsClient =>
  ({
    searchRelease: async () => ({
      results: [
        { id: 101, title: 'Various - Losing It', year: 1992, format: ['CD', 'Compilation'] },
        { id: 202, title: 'Fisher - Losing It', year: 2018, format: ['Vinyl', '12"'] }
      ]
    }),
    getRelease: async (id: number) => ({
      id,
      title: 'Losing It',
      year: 2018,
      artists: [{ id: 7, name: 'Fisher' }],
      labels: [{ id: 5, name: 'Catch & Release' }],
      styles: ['Tech House'],
      genres: ['Electronic']
    })
  }) as unknown as DiscogsClient

describe('seed picker — smart ranking', () => {
  it('auto-picks the artist match over a Various-Artists comp', async () => {
    const seed = await enrich(mockDiscogs(), { artist: 'Fisher', title: 'Losing It' })
    expect(seed?.releaseId).toBe(202)
    expect(seed?.artist).toContain('Fisher')
  })

  it('ranks the artist match first in the chooser', async () => {
    const cands = await searchSeeds(mockDiscogs(), { artist: 'Fisher', title: 'Losing It' })
    expect(cands[0].artist).toBe('Fisher')
    expect(cands[0].releaseId).toBe(202)
  })
})
