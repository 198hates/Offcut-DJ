// SoundCloud "related tracks" route — the strongest source for unofficial edits,
// bootlegs, flips and underground tracks, exactly the DJ material Discogs / Deezer
// / 1001TL don't carry.
//
// SoundCloud closed public API registration years ago, but its web player calls
// api-v2.soundcloud.com with a `client_id` baked into its JS bundles. We extract
// that id once (cached, re-fetched on a 401) and then talk to the structured JSON
// API. Same posture as the 1001TL public fallback: opt-in, ToS-gray, and returns
// empty rather than throwing so discovery never breaks.

import { RateLimiter } from './rate-limiter'
import { looksLikeMatch } from './match'

const API = 'https://api-v2.soundcloud.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const limiter = new RateLimiter(250)

interface ScUser { username?: string }
interface ScTrack { id?: number; title?: string; user?: ScUser }
interface ScCollection { collection?: ScTrack[] }

/** {artist,title} for a candidate, parsed from a (messy) SoundCloud track. */
export interface ScRef { artist: string; title: string }

// SoundCloud titles are inconsistent: edits are usually "Orig Artist - Track
// (Editor Edit)" uploaded by the editor, while official tracks are just "Track"
// uploaded by the artist. Prefer splitting "Artist - Title"; else use the uploader.
function parseArtist(t: ScTrack): string {
  const i = (t.title || '').indexOf(' - ')
  return (i > 0 ? t.title!.slice(0, i) : t.user?.username || '').trim()
}
function parseTitle(t: ScTrack): string {
  const i = (t.title || '').indexOf(' - ')
  return (i > 0 ? t.title!.slice(i + 3) : t.title || '').trim()
}
const toRef = (t: ScTrack): ScRef => ({ artist: parseArtist(t), title: parseTitle(t) })

export class SoundCloudClient {
  private clientId: string | null = null

  /** Pull the web player's client_id out of its JS bundles (cached). */
  private async getClientId(force = false): Promise<string | null> {
    if (this.clientId && !force) return this.clientId
    try {
      const html = await (await fetch('https://soundcloud.com/', { headers: { 'User-Agent': UA } })).text()
      // The player loads several asset bundles; the id lives in one of them
      // (usually the later ones), as client_id:"…" inside the API-call builder.
      const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
      for (const src of scripts.reverse()) {
        try {
          const js = await (await fetch(src, { headers: { 'User-Agent': UA } })).text()
          const m = js.match(/client_id\s*[:=]\s*"([0-9a-zA-Z]{20,40})"/)
          if (m) {
            this.clientId = m[1]
            return this.clientId
          }
        } catch {
          /* try the next bundle */
        }
      }
    } catch {
      /* offline / blocked */
    }
    return null
  }

  /** GET an api-v2 path with the client_id; re-extract + retry once on a 401. */
  private async get<T>(path: string): Promise<T | null> {
    const run = (id: string): Promise<Response> =>
      limiter.schedule(() =>
        fetch(`${API}${path}${path.includes('?') ? '&' : '?'}client_id=${id}`, { headers: { 'User-Agent': UA } })
      )
    let id = await this.getClientId()
    if (!id) return null
    let res = await run(id)
    if (res.status === 401) {
      id = await this.getClientId(true)
      if (!id) return null
      res = await run(id)
    }
    if (!res.ok) return null
    try {
      return (await res.json()) as T
    } catch {
      return null
    }
  }

  /** Resolve a seed to a SoundCloud track id (fuzzy-verified, else top hit). */
  private async resolveTrackId(artist: string, title: string): Promise<number | null> {
    const q = encodeURIComponent(`${artist} ${title}`.trim())
    const data = await this.get<ScCollection>(`/search/tracks?q=${q}&limit=10`)
    const hits = data?.collection || []
    const match = hits.find(
      (t) => looksLikeMatch({ artist }, parseArtist(t), parseTitle(t)) || looksLikeMatch({ artist }, t.user?.username, t.title)
    )
    return match?.id ?? hits[0]?.id ?? null
  }

  /** Tracks SoundCloud considers related to the seed ("if you like this…"). */
  async relatedTracks(artist: string, title: string, limit = 20): Promise<ScRef[]> {
    const id = await this.resolveTrackId(artist, title)
    if (!id) return []
    const data = await this.get<ScCollection>(`/tracks/${id}/related?limit=${limit}`)
    return (data?.collection || []).map(toRef).filter((t) => t.artist && t.title)
  }

  /** Raw track search — the versions route filters these to the seed composition. */
  async searchTracks(artist: string, title: string, limit = 25): Promise<ScRef[]> {
    const q = encodeURIComponent(`${artist} ${title}`.trim())
    if (!q) return []
    const data = await this.get<ScCollection>(`/search/tracks?q=${q}&limit=${limit}`)
    return (data?.collection || []).map(toRef).filter((t) => t.artist && t.title)
  }
}
