// Sonic-similarity route via Deezer's public catalogue — NO API KEY required.
//
// Discogs gives the *structural* lineage (who played on it, what label it was
// on); MusicBrainz gives sample/cover lineage; Last.fm gives listener overlap
// but needs a key the user may not have set. Deezer fills the gap for free:
//   seed -> Deezer artist -> /artist/{id}/related -> each related artist's top
//   tracks. That's a collaborative-filtering "sounds like" signal that works on
// every dig with zero configuration, so a track with thin Discogs credits (an
// instrumental electronic 12", say) still gets a real sonic branch instead of
// only tangential label-compilation routes.

import { RateLimiter } from './rate-limiter'
import { httpJson } from './http'
import { looksLikeMatch } from './match'

const BASE = 'https://api.deezer.com'
// Deezer's published ceiling is ~50 requests / 5 s. A dig fans out to ~1 search
// + 1 related + N top-track calls, so space them ~4.5/s to stay well under.
const limiter = new RateLimiter(220)

interface DeezerArtist {
  id?: number
  name?: string
}
interface DeezerSearchHit {
  title?: string
  artist?: DeezerArtist
}
interface DeezerTopTrack {
  title?: string
  artist?: DeezerArtist
}

/** A related artist and their top tracks — one sonic sub-branch off the seed. */
export interface RelatedArtistGroup {
  id: number
  name: string
  /** Closeness to the seed, 0..1 — higher = a nearer related artist. */
  weight: number
  tracks: { artist: string; title: string }[]
}

export class DeezerClient {
  private get<T>(path: string): Promise<T> {
    return limiter.schedule(() => httpJson<T>(`${BASE}${path}`, { label: `Deezer ${path}` }))
  }

  /**
   * Raw Deezer track search for `${artist} ${title}` — returns every catalogue
   * track matching the query (the original plus its remixes/edits/versions). The
   * caller filters these down to the seed's composition. Keyless.
   */
  async searchTracks(
    artist: string,
    title: string,
    limit = 25
  ): Promise<{ artist: string; title: string }[]> {
    const q = encodeURIComponent(`${artist} ${title}`.trim())
    if (!q) return []
    try {
      const { data = [] } = await this.get<{ data?: DeezerSearchHit[] }>(`/search/track?q=${q}&limit=${limit}`)
      return data
        .map((d) => ({ artist: d.artist?.name || '', title: d.title || '' }))
        .filter((t) => t.artist && t.title)
    } catch {
      return []
    }
  }

  /** Resolve the seed to a Deezer artist id (verified by a fuzzy name match). */
  private async artistId(artist: string, title: string): Promise<number | null> {
    const q = encodeURIComponent(`${artist} ${title}`)
    try {
      const { data = [] } = await this.get<{ data?: DeezerSearchHit[] }>(`/search?q=${q}&limit=5`)
      const hit = data.find((d) => looksLikeMatch({ artist }, d.artist?.name, d.title))
      if (hit?.artist?.id) return hit.artist.id
    } catch {
      /* fall through to the artist-only search */
    }
    // Fall back to an artist-only search when the track line doesn't match.
    return (await this.artistOnly(artist))?.id ?? null
  }

  private async artistOnly(artist: string): Promise<DeezerArtist | null> {
    try {
      const { data = [] } = await this.get<{ data?: DeezerArtist[] }>(
        `/search/artist?q=${encodeURIComponent(artist)}&limit=3`
      )
      return data.find((a) => looksLikeMatch({ artist }, a.name)) || data[0] || null
    } catch {
      return null
    }
  }

  /**
   * Artists Deezer considers related to the seed's artist, each with their top
   * tracks — one sonic sub-branch per artist. `fanout` related artists,
   * `perArtist` top tracks each. Weight decreases with the related-artist rank
   * so the closest neighbours' branches score highest.
   */
  async relatedArtistGroups(
    artist: string,
    title: string,
    { fanout = 6, perArtist = 6 }: { fanout?: number; perArtist?: number } = {}
  ): Promise<RelatedArtistGroup[]> {
    const id = await this.artistId(artist, title)
    if (!id) return []
    let related: DeezerArtist[] = []
    try {
      const { data = [] } = await this.get<{ data?: DeezerArtist[] }>(`/artist/${id}/related?limit=12`)
      related = data.filter((a) => a.id && a.name).slice(0, fanout)
    } catch {
      return []
    }
    const groups: RelatedArtistGroup[] = []
    const n = related.length || 1
    for (let i = 0; i < related.length; i++) {
      const a = related[i]
      const weight = (n - i) / n // nearest related artist -> 1, furthest -> ~0
      try {
        const { data = [] } = await this.get<{ data?: DeezerTopTrack[] }>(
          `/artist/${a.id}/top?limit=${perArtist}`
        )
        const tracks = data
          .map((t) => ({ artist: t.artist?.name || a.name || '', title: t.title || '' }))
          .filter((t) => t.artist && t.title)
        if (tracks.length) groups.push({ id: a.id!, name: a.name!, weight, tracks })
      } catch {
        /* best-effort per related artist */
      }
    }
    return groups
  }
}
