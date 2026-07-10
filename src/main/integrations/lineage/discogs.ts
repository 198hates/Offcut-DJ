import { RateLimiter } from './rate-limiter'
import { httpText } from './http'

const BASE = 'https://api.discogs.com'

/** Read-through cache for stable Discogs GETs (release/artist/label data). */
export interface ResponseCache {
  get(url: string): string | null
  set(url: string, body: string): void
}

// ── Response shapes (only the fields we read) ───────────────────────────────────

export interface DiscogsArtistRef {
  id?: number
  name: string
}

export interface DiscogsLabelRef {
  id?: number
  name: string
}

export interface DiscogsExtraArtist {
  id?: number
  name: string
  role?: string
}

export interface DiscogsTracklistEntry {
  title?: string
  artists?: DiscogsArtistRef[]
  extraartists?: DiscogsExtraArtist[]
}

/** A full release from /releases/{id}. */
export interface DiscogsRelease {
  id: number
  title: string
  year?: number
  artists?: DiscogsArtistRef[]
  labels?: DiscogsLabelRef[]
  styles?: string[]
  genres?: string[]
  extraartists?: DiscogsExtraArtist[]
  tracklist?: DiscogsTracklistEntry[]
}

/** A release summary from /database/search. */
export interface DiscogsSearchResult {
  id: number
  /** Discogs combines artist + title into one line, e.g. "Floating Points - Silhouettes". */
  title: string
  year?: string | number
  label?: string[]
  format?: string[]
  country?: string
  thumb?: string
  cover_image?: string
}

export interface DiscogsSearchResponse {
  results?: DiscogsSearchResult[]
}

/** A release summary from /artists/{id}/releases and /labels/{id}/releases. */
export interface DiscogsReleaseSummary {
  id?: number
  title: string
  year?: number
  artist?: string
  label?: string
  role?: string
  type?: string
  format?: string
}

/** Label detail from /labels/{id} — sublabels + parent for the label-family route. */
export interface DiscogsLabelDetail {
  id: number
  name: string
  sublabels?: DiscogsLabelRef[]
  parent_label?: DiscogsLabelRef
}

export interface DiscogsReleasesResponse {
  releases?: DiscogsReleaseSummary[]
}

export interface DiscogsSearchParams {
  q?: string
  artist?: string
  track?: string
}

type QueryParams = Record<string, string | number | undefined>

export class DiscogsClient {
  private token?: string
  private userAgent: string
  private limiter: RateLimiter
  private cache?: ResponseCache
  /** True when a personal access token was supplied (higher rate limit). */
  readonly authenticated: boolean

  constructor({
    token,
    userAgent,
    cache
  }: {
    token?: string
    userAgent: string
    cache?: ResponseCache
  }) {
    if (!userAgent) throw new Error('Discogs requires a descriptive User-Agent')
    this.token = token || undefined
    this.userAgent = userAgent // e.g. 'Offcut/1.0 +https://github.com/198hates/Offcut-DJ'
    this.cache = cache
    this.authenticated = !!this.token
    // Authenticated: ~55 req/min (under the 60 cap). Unauthenticated: ~24/min
    // (under the 25 cap) — space requests further apart to avoid 429s.
    this.limiter = new RateLimiter(this.authenticated ? 1100 : 2500)
  }

  private async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v))
    }
    const key = url.toString()

    // Cache hit skips both the rate limiter and the network entirely.
    const cached = this.cache?.get(key)
    if (cached != null) return JSON.parse(cached) as T

    return this.limiter.schedule(async () => {
      const headers: Record<string, string> = { 'User-Agent': this.userAgent }
      if (this.token) headers.Authorization = `Discogs token=${this.token}`
      const text = await httpText(url, { headers, label: `Discogs ${path}` })
      this.cache?.set(key, text)
      return JSON.parse(text) as T
    })
  }

  // Find a release by free text, or by structured artist/track.
  searchRelease({ q, artist, track }: DiscogsSearchParams): Promise<DiscogsSearchResponse> {
    return this.get('/database/search', { type: 'release', q, artist, track, per_page: 5 })
  }

  getRelease(id: number): Promise<DiscogsRelease> {
    return this.get(`/releases/${id}`)
  }

  // An artist's discography — the "more from whoever made this sound" signal.
  getArtistReleases(id: number): Promise<DiscogsReleasesResponse> {
    return this.get(`/artists/${id}/releases`, { sort: 'year', sort_order: 'desc', per_page: 50 })
  }

  // A label's catalogue — scene/era neighbours.
  getLabelReleases(id: number): Promise<DiscogsReleasesResponse> {
    return this.get(`/labels/${id}/releases`, { per_page: 100 })
  }

  // Label detail — exposes sublabels and parent_label for the label-family route.
  getLabel(id: number): Promise<DiscogsLabelDetail> {
    return this.get(`/labels/${id}`)
  }
}
