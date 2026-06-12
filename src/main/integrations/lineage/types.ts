// The engine runs entirely in the main process: network calls (no CORS),
// API keys, SQLite, audio fingerprinting.
//
// The wire DTOs (Seed, Candidate, PreviewResult, …) live in src/shared so the
// renderer's viewer can use the same shapes; they are re-exported here so the
// engine modules can keep importing from a single local module.

export type {
  LibraryTrackRef,
  Credit,
  PlayerCredit,
  LabelRef,
  EnrichInput,
  SeedCandidate,
  Seed,
  Candidate,
  CandidateStatus,
  StoredCandidate,
  RouteType,
  Direction,
  DiscoverFilters,
  DiscoverOptions,
  DiscoverSeed,
  DiscoverResult,
  DiscoverProgress,
  PreviewLinks,
  PreviewResult,
  BandcampEmbed,
  IdentityResult,
  DeezerTrack
} from '../../../shared/types'

import type { LibraryTrackRef } from '../../../shared/types'

/** Configuration passed to createLineageEngine(). */
export interface LineageEngineConfig {
  /** Free Discogs personal access token. Optional — unauthenticated works, slower. */
  discogsToken?: string
  /** Free AcoustID application API key (identity / fingerprint lookups). */
  acoustidKey?: string
  /** Descriptive User-Agent — Discogs & MusicBrainz reject blank UAs. */
  userAgent: string
  /** Path to the bundled `fpcalc` binary; defaults to PATH. */
  fpcalcPath?: string
  /** e.g. path.join(app.getPath('userData'), 'lineage.db') */
  dbPath: string
  /** Pulls {artist,title} from the host app's library, to seed dedup. */
  getLibraryTracks?: () => LibraryTrackRef[]
  /** Free Last.fm API key — enables the "listeners also play" route. Omit to skip it. */
  lastfmKey?: string
  /** 1001Tracklists partner API key — enables the "played alongside" route. */
  tracklistsApiKey?: string
  /** 1001Tracklists partner API base URL (paired with tracklistsApiKey). */
  tracklistsApiBase?: string
  /** Opt in to the fragile public 1001TL fallback when no partner API is set. */
  enableTracklistsScrape?: boolean
}
