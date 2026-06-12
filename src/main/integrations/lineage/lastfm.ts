// Listener-similarity route: Last.fm's collaborative "people who play X also
// play Y" data — the crowd-behaviour complement to the credit/label lineage,
// and a working stand-in for Spotify's removed recommendation endpoints.
// A free Last.fm API key is required.

import { RateLimiter } from './rate-limiter'
import { httpJson } from './http'

const limiter = new RateLimiter(250)
const BASE = 'https://ws.audioscrobbler.com/2.0/'

export interface SimilarTrack {
  artist: string
  title: string
  /** Listener-overlap match, 0..1. */
  match: number
}

export interface SimilarArtist {
  name: string
  match: number
}

export class LastfmClient {
  private key: string

  constructor({ apiKey }: { apiKey: string }) {
    if (!apiKey) throw new Error('Last.fm API key required')
    this.key = apiKey
  }

  private get<T>(params: Record<string, string | number>): Promise<T> {
    const url = new URL(BASE)
    url.searchParams.set('api_key', this.key)
    url.searchParams.set('format', 'json')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    return limiter.schedule(() => httpJson<T>(url, { label: 'Last.fm' }))
  }

  // [{ artist, title, match }] ranked by listener overlap (0..1).
  async similarTracks(artist: string, title: string, limit = 24): Promise<SimilarTrack[]> {
    const d = await this.get<{
      similartracks?: { track?: { name?: string; match?: string; artist?: { name?: string } }[] }
    }>({ method: 'track.getsimilar', artist, track: title, limit, autocorrect: 1 })
    return (d?.similartracks?.track || [])
      .map((t) => ({
        artist: t.artist?.name || '',
        title: t.name || '',
        match: parseFloat(t.match || '0') || 0
      }))
      .filter((t) => t.artist && t.title)
  }

  // [{ name, match }] similar artists, if an artist-level branch is wanted too.
  async similarArtists(artist: string, limit = 12): Promise<SimilarArtist[]> {
    const d = await this.get<{ similarartists?: { artist?: { name?: string; match?: string }[] } }>({
      method: 'artist.getsimilar',
      artist,
      limit,
      autocorrect: 1
    })
    return (d?.similarartists?.artist || []).map((a) => ({
      name: a.name || '',
      match: parseFloat(a.match || '0') || 0
    }))
  }
}
