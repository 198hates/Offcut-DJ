// DJ-set co-play route via 1001Tracklists — "what gets mixed next to this in
// real sets", the most DJ-relevant adjacency signal there is.
//
// IMPORTANT: 1001Tracklists has no open API. The reliable path is their
// commercial/partner API (configure apiBase + apiKey). Without it, the public
// fallback is best-effort only: their pages are JS-heavy and Cloudflare-
// protected, and their ToS restricts scraping — so it's opt-in, fragile, and
// returns nothing rather than throwing. The co-occurrence ranking below is
// source-agnostic and is the reusable core regardless of where sets come from.

import { RateLimiter } from './rate-limiter'
import { dedupKey } from './store'
import { findTrackPage, trackSetUrls, fetchTracklistTracks } from './tracklists-scrape'

const limiter = new RateLimiter(1500)

/** One track in a DJ set's ordered tracklist. */
export interface SetTrack {
  artist: string
  title: string
}

/** A co-played track ranked by how often it sits near the seed in real sets. */
export interface CoPlay {
  artist: string
  title: string
  weight: number
}

// Given DJ sets (each an ordered list of {artist,title}) that contain the seed,
// rank the other tracks by how often they're played alongside it — weighting
// tracks that sit DIRECTLY next to the seed (true "these mix") above mere
// same-set co-occurrence.
export function tallyCoPlay(sets: SetTrack[][], seedKey: string, limit = 24): CoPlay[] {
  const tally = new Map<string, CoPlay>()
  for (const set of sets) {
    const idx = set.findIndex((t) => dedupKey(t.artist, t.title) === seedKey)
    if (idx === -1) continue
    set.forEach((t, i) => {
      if (i === idx) return
      const key = dedupKey(t.artist, t.title)
      if (!key) return
      const w = Math.abs(i - idx) === 1 ? 3 : 1 // adjacent >> elsewhere in the set
      const cur = tally.get(key) || { artist: t.artist, title: t.title, weight: 0 }
      cur.weight += w
      tally.set(key, cur)
    })
  }
  return [...tally.values()].sort((a, b) => b.weight - a.weight).slice(0, limit)
}

export class TracklistsClient {
  private apiBase: string | null
  private apiKey: string | null
  private scrape: boolean

  constructor({
    apiBase = null,
    apiKey = null,
    scrape = false
  }: {
    apiBase?: string | null
    apiKey?: string | null
    userAgent?: string
    scrape?: boolean
  } = {}) {
    this.apiBase = apiBase
    this.apiKey = apiKey
    this.scrape = scrape
  }

  // -> [{ artist, title, weight }]
  async coPlayed({ artist, title }: SetTrack, limit = 24): Promise<CoPlay[]> {
    const seedKey = dedupKey(artist, title)
    let sets: SetTrack[][] = []
    try {
      if (this.apiBase && this.apiKey) sets = await this.viaApi({ artist, title })
      else if (this.scrape) sets = await this.viaPublic({ artist, title })
    } catch {
      sets = []
    }
    return tallyCoPlay(sets, seedKey, limit)
  }

  // Official partner API — the reliable path. Fill in the documented endpoints
  // once you have access; return an array of sets, each an ordered [{artist,title}].
  private async viaApi(_q: SetTrack): Promise<SetTrack[][]> {
    // const hdr = { headers: { 'x-api-key': this.apiKey, 'User-Agent': this.userAgent } }
    // 1) resolve the track id  2) fetch the tracklists it appears in  3) map to ordered tracks
    return [] // implement against the partner API docs
  }

  // Best-effort public fallback — fragile (Cloudflare + ToS), opt-in only.
  // Renders 1001TL's JS search to find tracklists featuring the seed, then parses
  // each set's ordered tracks. tallyCoPlay keeps only sets that actually contain
  // the seed, so loosely-related search hits contribute nothing. Returns [] on
  // anything unexpected so discovery never breaks.
  private async viaPublic({ artist, title }: SetTrack, maxSets = 10): Promise<SetTrack[][]> {
    const trackUrl = await findTrackPage(`${artist} ${title}`)
    if (!trackUrl) return []
    const setUrls = await trackSetUrls(trackUrl, maxSets)
    const sets: SetTrack[][] = []
    for (const url of setUrls) {
      const set = await limiter.schedule(() => fetchTracklistTracks(url))
      if (set.length) sets.push(set)
    }
    return sets
  }
}
