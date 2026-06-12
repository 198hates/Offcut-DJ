// Single entry point that assembles the whole Lineage engine and exposes a
// flat API. Everything here runs in Electron's MAIN process.

import { DiscogsClient } from './discogs'
import { LineageStore } from './store'
import { enrich, searchSeeds } from './enrich'
import { discover } from './discover'
import { preview } from './preview'
import { embedFor, previewBandcamp } from './bandcamp'
import { Identity, deezerByIsrc } from './identity'
import { LastfmClient } from './lastfm'
import { TracklistsClient } from './tracklists'
import { readRekordbox, writeRekordboxPlaylist } from './dj-library/rekordbox'
import type { RekordboxFind } from './dj-library/rekordbox'
import { readSeratoCrate } from './dj-library/serato'
import type {
  BandcampEmbed,
  CandidateStatus,
  LineageEngineConfig,
  DeezerTrack,
  DiscoverOptions,
  DiscoverProgress,
  DiscoverResult,
  EnrichInput,
  IdentityResult,
  LibraryTrackRef,
  PreviewResult,
  Seed,
  SeedCandidate,
  StoredCandidate
} from './types'

export interface LineageEngine {
  /** True when a Discogs token was supplied (higher rate limit). */
  authenticated: boolean
  /** True when a Last.fm key is configured (listener route is live). */
  hasLastfm: boolean
  /** True when a 1001Tracklists source is configured (set route is live). */
  hasTracklists: boolean
  // library / dedup
  loadLibrary: (tracks: LibraryTrackRef[]) => void
  loadRekordbox: (xmlPath: string) => void
  loadSerato: (cratePath: string) => string[]
  // enrichment + discovery
  enrich: (input: EnrichInput) => Promise<Seed | null>
  /** Top Discogs matches for a typed artist/title — drives the seed picker. */
  searchSeeds: (input: { artist?: string; title?: string }) => Promise<SeedCandidate[]>
  discover: (
    seed: Seed,
    opts?: DiscoverOptions,
    onProgress?: (p: DiscoverProgress) => void
  ) => Promise<DiscoverResult>
  // identity backbone
  identify: (input: { filePath?: string; artist?: string; title?: string }) => Promise<IdentityResult | null>
  deezerByIsrc: (isrc: string) => Promise<DeezerTrack | null>
  // preview / playback
  preview: (track: LibraryTrackRef) => Promise<PreviewResult>
  bandcampPreview: (track: LibraryTrackRef) => Promise<BandcampEmbed | null>
  bandcampEmbed: (url: string) => Promise<BandcampEmbed | null>
  // review workflow
  listNew: () => StoredCandidate[]
  save: (key: string) => void
  dismiss: (key: string) => void
  listSaved: () => StoredCandidate[]
  // export
  exportCrate: (finds: RekordboxFind[], name: string, outPath: string) => string
  /** Release the underlying SQLite handle — call before rebuilding the engine. */
  close: () => void
}

export function createLineageEngine(opts: LineageEngineConfig): LineageEngine {
  const { discogsToken, userAgent, dbPath, acoustidKey, fpcalcPath = 'fpcalc', lastfmKey } = opts

  const store = new LineageStore(dbPath)
  // Discogs release/artist/label data is effectively immutable — cache it for
  // two weeks so re-digs and overlapping seeds skip the network and rate limit.
  const DISCOGS_TTL = 1000 * 60 * 60 * 24 * 14
  const discogs = new DiscogsClient({
    token: discogsToken,
    userAgent,
    cache: {
      get: (url) => store.getCached(url, DISCOGS_TTL),
      set: (url, body) => store.putCached(url, body)
    }
  })
  const identity = new Identity({ acoustidKey, userAgent, fpcalcPath })
  const lastfm = lastfmKey ? new LastfmClient({ apiKey: lastfmKey }) : null
  // The "played alongside" route only has a real source via the 1001Tracklists
  // partner API (apiBase + apiKey). The public scrape is a deliberate no-op
  // (Cloudflare + ToS), so a scrape-only config would surface an always-empty
  // route — we'd rather not advertise it. Require the partner API to enable it.
  const tracklists =
    opts.tracklistsApiKey && opts.tracklistsApiBase
      ? new TracklistsClient({
          apiBase: opts.tracklistsApiBase,
          apiKey: opts.tracklistsApiKey,
          userAgent
        })
      : null

  return {
    authenticated: discogs.authenticated,
    hasLastfm: !!lastfm,
    hasTracklists: !!tracklists,

    // --- library / dedup ---
    loadLibrary: (tracks) => store.loadLibrary(tracks),
    loadRekordbox: (xmlPath) => store.loadLibrary(readRekordbox(xmlPath).tracks),
    loadSerato: (cratePath) => readSeratoCrate(cratePath),

    // --- enrichment + discovery ---
    enrich: (input) => enrich(discogs, input),
    searchSeeds: (input) => searchSeeds(discogs, input),
    discover: (seed, o, onProgress) =>
      discover(discogs, store, seed, o, { lastfm, identity, tracklists }, onProgress),

    // --- identity backbone ---
    identify: (input) => identity.identify(input),
    deezerByIsrc,

    // --- preview / playback ---
    preview: (track) => preview(track, identity),
    bandcampPreview: (track) => previewBandcamp(track),
    bandcampEmbed: (url) => embedFor(url),

    // --- review workflow ---
    listNew: () => store.listCandidates('new'),
    save: (key) => store.setStatus(key, 'saved' as CandidateStatus),
    dismiss: (key) => store.setStatus(key, 'dismissed' as CandidateStatus),
    listSaved: () => store.listCandidates('saved'),

    // --- export ---
    exportCrate: (finds, name, outPath) =>
      writeRekordboxPlaylist({ finds, playlistName: name, outPath }),

    close: () => store.close()
  }
}
