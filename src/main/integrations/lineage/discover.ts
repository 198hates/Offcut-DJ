// Discovery returns the seed's relationships grouped into DIRECTIONS (branches),
// each with a ranked POOL the UI windows to 5 and shuffles through. Routes:
//   remix/producer · shared players · same label · sub-label family ·
//   listeners-also (Last.fm) · sample lineage (MusicBrainz) ·
//   same compilation (Discogs) · played-alongside (1001Tracklists)
// Each pooled candidate is persisted tagged with its direction + seed-chain so a
// promoted sub-seed still traces back to the origin.

import { dedupKey } from './store'
import type { LineageStore } from './store'
import type { DiscogsClient, DiscogsReleaseSummary, DiscogsSearchResult } from './discogs'
import type { Identity } from './identity'
import type { LastfmClient } from './lastfm'
import type { DeezerClient } from './deezer'
import type { TracklistsClient } from './tracklists'
import type { SoundCloudClient } from './soundcloud'
import type {
  Candidate,
  Direction,
  DiscoverFilters,
  DiscoverOptions,
  DiscoverProgress,
  DiscoverResult,
  LibraryTrackRef,
  RouteType,
  Seed
} from './types'

/** Optional data sources; each route is skipped when its client is absent. */
export interface DiscoverClients {
  lastfm?: LastfmClient | null
  identity?: Identity | null
  tracklists?: TracklistsClient | null
  /** Keyless Deezer related-artists route — present on every dig. */
  deezer?: DeezerClient | null
  /** SoundCloud related-tracks route (opt-in) — edits, bootlegs, underground. */
  soundcloud?: SoundCloudClient | null
  /** The user's library ({artist,title}) — surfaces owned versions/remixes of the seed. */
  library?: LibraryTrackRef[]
}

// Discogs formats release/result titles as "Artist - Title".
function splitTitle(t = ''): { artist: string; title: string } {
  const i = t.indexOf(' - ')
  return i === -1 ? { artist: '', title: t } : { artist: t.slice(0, i), title: t.slice(i + 3) }
}

// /database/search results carry label/format as arrays and year as a string —
// normalise to the release-summary shape buildPool consumes.
function searchToSummary(r: DiscogsSearchResult): DiscogsReleaseSummary {
  return {
    id: r.id,
    title: r.title,
    year: r.year != null ? Number(r.year) || undefined : undefined,
    label: r.label?.[0],
    format: r.format?.join(', ')
  }
}

// The underlying composition title, stripping the "(… Remix/Edit/Mix)" suffix so
// we can search Discogs for every other version of the same track.
function compositionTitle(title: string): string {
  return (title.split(/\s*[([]/)[0] || title).trim()
}

// Identity key that PRESERVES the version descriptor (unlike dedupKey, which
// collapses "(… Remix)"). Lets the versions route keep each remix/version of one
// composition as a distinct candidate while still excluding the seed's own cut.
function fullKey(artist = '', title = ''): string {
  return `${artist} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// All routes score on a shared 0–100 scale so directions rank by how reliably
// the relationship tracks the seed's *sound*, not by which formula produced the
// number. Era proximity meaningfully reorders within a route: a same-label
// release from the seed's own years is a far stronger lead than one 30 years off.
function eraBonus(relYear: number | null | undefined, seed: Seed): number {
  if (!seed.year || !relYear) return 0
  const gap = Math.abs(seed.year - relYear)
  return gap <= 2 ? 12 : gap <= 5 ? 7 : gap <= 10 ? 3 : gap >= 25 ? -4 : 0
}
function scoreFor(rel: { year?: number | null }, seed: Seed, base: number): number {
  return base + eraBonus(rel.year, seed)
}
// Owned tracks are kept (a strong link you already have validates the branch),
// but deranked so genuinely new finds lead — unless the user opts to rank them
// equally via the includeOwned filter.
const OWNED_PENALTY = 12

/**
 * A reusable candidate gate built from the user's filters. Used by every route
 * (Discogs pools and the inline listener/sample/comp/set pools) so the filter
 * behaviour is identical everywhere.
 *
 * - owned: NO LONGER dropped — owned tracks are surfaced (and tagged + deranked
 *          elsewhere) because a strong link you already hold validates a branch.
 * - year:  candidates with no year always pass (era is often unknown); only
 *          dated candidates outside [yearMin, yearMax] are dropped.
 * - label: when a labelQuery is set, only candidates whose label contains it
 *          survive (so listener/sample results with no label are dropped — a
 *          label filter is an explicit "I want this imprint" intent).
 */
type CandidateLike = { artist: string; title: string; year: number | null; label: string | null }

function makeKeep(filters: DiscoverFilters): (c: CandidateLike) => boolean {
  const labelQ = filters.labelQuery?.trim().toLowerCase() || null
  return (c) => {
    if (filters.yearMin != null && c.year != null && c.year < filters.yearMin) return false
    if (filters.yearMax != null && c.year != null && c.year > filters.yearMax) return false
    if (labelQ && (!c.label || !c.label.toLowerCase().includes(labelQ))) return false
    return true
  }
}

/** Tag a freshly-built candidate as owned and derank it (unless ranking owned equally). */
function applyOwned<T extends { artist: string; title: string; score: number }>(
  c: T,
  store: LineageStore,
  rankOwnedEqually: boolean
): T & { owned: boolean } {
  const owned = store.owns(c.artist, c.title)
  return {
    ...c,
    owned,
    score: owned && !rankOwnedEqually ? c.score - OWNED_PENALTY : c.score
  }
}

interface PoolContext {
  seed: Seed
  store: LineageStore
  base: number
  why: string
  /** Releases summaries carry "Artist - Title" in `.title` when from an artist discography. */
  fromArtist: boolean
  keep: (c: CandidateLike) => boolean
  rankOwnedEqually: boolean
  /** Dedup/identity key. Defaults to dedupKey (composition-level — collapses
   *  remixes of one track). The versions route overrides it with fullKey so each
   *  remix/version of the seed stays a distinct candidate. */
  keyOf?: (artist: string, title: string) => string
}

// Discogs release summaries -> one direction's ranked, deduped, filtered pool.
function buildPool(
  releases: DiscogsReleaseSummary[],
  { seed, store, base, why, fromArtist, keep, rankOwnedEqually, keyOf = dedupKey }: PoolContext,
  poolSize: number
): Candidate[] {
  const seen = new Set([keyOf(seed.artist, seed.title)])
  const out: Candidate[] = []
  for (const rel of releases) {
    const parsed = splitTitle(rel.title)
    const artist = fromArtist ? parsed.artist || rel.artist || '' : rel.artist || ''
    const title = fromArtist ? parsed.title : rel.title
    if (!artist || !title) continue
    const key = keyOf(artist, title)
    if (seen.has(key)) continue
    const label = rel.label || null
    const year = rel.year || null
    if (!keep({ artist, title, year, label })) continue
    seen.add(key)
    out.push(
      applyOwned(
        {
          key,
          artist,
          title,
          label,
          year,
          discogs_id: rel.id || null,
          why,
          score: scoreFor(rel, seed, base)
        },
        store,
        rankOwnedEqually
      )
    )
  }
  return out.sort((a, b) => b.score - a.score).slice(0, poolSize)
}

/**
 * Cross-direction dedup. Each route dedups *within* its own pool, but the same
 * track legitimately surfaces from several routes (e.g. on the same label AND
 * played alongside the seed). Left alone it takes a slot in every branch's pool
 * and the persisted candidate (keyed by track) keeps only one branch's reason.
 *
 * Keep each track in its single strongest branch only, freeing the weaker
 * branches for genuinely new finds. Run as a deterministic post-pass over the
 * finished pools — a shared `seen` during the concurrent routes would make the
 * winner depend on network timing.
 */
export function dedupeAcrossDirections(directions: Direction[]): void {
  const ordered = [...directions].sort(
    (a, b) =>
      (b.pool[0]?.score || 0) - (a.pool[0]?.score || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const claimed = new Set<string>()
  for (const d of ordered) {
    d.pool = d.pool.filter((c) => {
      if (claimed.has(c.key)) return false
      claimed.add(c.key)
      return true
    })
  }
}

// discogs, store required. opts: { poolSize=24, maxDirections=8, rootSeedKey? }.
// clients: { lastfm?, identity?, tracklists? } — each optional; route skipped if absent.
export async function discover(
  discogs: DiscogsClient,
  store: LineageStore,
  seed: Seed,
  opts: DiscoverOptions = {},
  clients: DiscoverClients = {},
  onProgress?: (p: DiscoverProgress) => void
): Promise<DiscoverResult> {
  const { lastfm = null, identity = null, tracklists = null, deezer = null, soundcloud = null, library = [] } = clients
  const poolSize = opts.poolSize ?? 24
  // Higher than before: a dig now splits the sonic route into one branch per
  // related artist, so the cap has to leave room for those plus the credit /
  // label / sample structural branches.
  const maxDirections = opts.maxDirections ?? 12
  const filters = opts.filters ?? {}
  const keep = makeKeep(filters)
  // Owned tracks are surfaced + tagged; rank them at full score only when asked.
  const rankOwnedEqually = !!filters.includeOwned
  // A route runs only when its type is enabled (empty/undefined routes = all).
  const routeEnabled = (type: RouteType): boolean =>
    !filters.routes?.length || filters.routes.includes(type)
  const seedKey = dedupKey(seed.artist, seed.title)
  const rootSeedKey = opts.rootSeedKey || seedKey
  const directions: Direction[] = []
  const push = (d: Direction): void => {
    if (d.pool.length) directions.push(d)
  }

  // ── progress accounting (drives the renderer's loading bar) ──────────────
  const persons = [...(seed.remixers || []), ...(seed.producers || [])].filter((p) => p.id)
  const playerList = (seed.players || []).slice(0, 4).filter((p) => p.id)
  const labelList = (seed.labels || []).filter((l) => l.id)
  const seedArtistId = (seed.artists || [])[0]?.id
  const total = Math.max(
    (routeEnabled('version') ? 1 : 0) +
      (routeEnabled('remix') ? persons.length : 0) +
      (routeEnabled('players') ? playerList.length : 0) +
      (routeEnabled('label') ? labelList.length : 0) /* same-label */ +
      (routeEnabled('label') ? labelList.length : 0) /* sister-label sweep */ +
      (lastfm && routeEnabled('listener') ? 1 : 0) +
      (deezer && routeEnabled('deezer') ? 1 : 0) +
      (identity && routeEnabled('sample') ? 1 : 0) +
      (seedArtistId && routeEnabled('comp') ? 1 : 0) +
      (tracklists && routeEnabled('set') ? 1 : 0) +
      (soundcloud && routeEnabled('soundcloud') ? 1 : 0),
    2
  )
  let done = 0
  const advance = (label: string): void => {
    done = Math.min(done + 1, total - 1)
    onProgress?.({ done, total, label })
  }
  onProgress?.({ done: 0, total, label: 'searching credits…' })

  // Routes are grouped by API host. The Discogs routes share one rate limiter,
  // so they stay a sequential chain; Last.fm, MusicBrainz and 1001Tracklists hit
  // different hosts, so they run concurrently *alongside* the Discogs chain.
  // Wall-clock becomes ~max(host) instead of the sum of every route.

  // ── Discogs chain: remix → players → label + sister labels → compilations ──
  const discogsWork = (async (): Promise<void> => {
    // 0. Other versions & remixes OF THE SEED ITSELF — the most direct lineage:
    //    search Discogs for the composition and surface every release of it
    //    (the original, edits, dubs and other artists' remixes of this track).
    if (routeEnabled('version')) {
      const base = compositionTitle(seed.title)
      // A candidate is a version of the seed when it shares the composition title
      // (artist dropped, remix suffix stripped via dedupKey('', title)) but is a
      // different cut from the seed itself.
      const seedTitleKey = dedupKey('', seed.title)
      const seedFull = fullKey(seed.artist, seed.title)
      const isVersion = (artist: string, title: string): boolean =>
        dedupKey('', title) === seedTitleKey && fullKey(artist, title) !== seedFull

      // Owned versions — the most reliable "remixes I have", no API needed.
      const ownedVersions: DiscogsReleaseSummary[] = library
        .filter((t) => isVersion(t.artist, t.title))
        .map((t) => ({ title: `${t.artist} - ${t.title}` }))

      // Two catalogues in parallel: Discogs releases of the composition + Deezer's
      // track search (filtered to the composition). Each independently best-effort.
      const versionSearch = async (
        fn: (() => Promise<{ artist: string; title: string }[]>) | null
      ): Promise<{ artist: string; title: string }[]> => {
        if (!fn) return []
        try { return (await fn()).filter((t) => isVersion(t.artist, t.title)) }
        catch { return [] }
      }
      const [discogsResults, deezerVersions, scVersions] = await Promise.all([
        (async (): Promise<DiscogsSearchResult[]> => {
          try { return (await discogs.searchRelease({ artist: seed.artist, track: base })).results ?? [] }
          catch { return [] }
        })(),
        versionSearch(deezer ? () => deezer.searchTracks(seed.artist, base) : null),
        versionSearch(soundcloud ? () => soundcloud.searchTracks(seed.artist, base) : null)
      ])

      push({
        id: `version:${seedKey}`,
        type: 'version',
        title: 'Remixes & versions',
        pool: buildPool(
          [
            ...ownedVersions,
            ...deezerVersions.map((t) => ({ title: `${t.artist} - ${t.title}` })),
            ...scVersions.map((t) => ({ title: `${t.artist} - ${t.title}` })),
            ...discogsResults.map(searchToSummary)
          ],
          // Owned versions are the whole point here — rank them at full score.
          { seed, store, base: 96, why: `A version or remix of “${base}”`, fromArtist: true, keep, rankOwnedEqually: true, keyOf: fullKey },
          poolSize
        )
      })
      advance('Finding remixes & versions…')
    }

    // 1. Remixers / producers — strongest "more of this sound".
    if (routeEnabled('remix')) {
      for (const p of [...(seed.remixers || []), ...(seed.producers || [])]) {
        if (!p.id) continue
        try {
          const { releases = [] } = await discogs.getArtistReleases(p.id)
          push({
            id: `person:${p.id}`,
            type: 'remix',
            title: p.name,
            pool: buildPool(
              releases,
              { seed, store, base: 94, why: `${p.name} (credited on your seed) also worked on this`, fromArtist: true, keep, rankOwnedEqually },
              poolSize
            )
          })
        } catch {
          /* best-effort per collaborator */
        }
        advance('Following collaborators…')
      }
    }

    // 2. Shared players — follow the bassist / drummer / keys.
    if (routeEnabled('players')) {
      for (const p of (seed.players || []).slice(0, 4)) {
        if (!p.id) continue
        try {
          const { releases = [] } = await discogs.getArtistReleases(p.id)
          push({
            id: `player:${p.id}`,
            type: 'players',
            title: p.name,
            pool: buildPool(
              releases,
              { seed, store, base: 86, why: `Shares a player — ${p.name}${p.role ? ` (${p.role})` : ''}`, fromArtist: true, keep, rankOwnedEqually },
              poolSize
            )
          })
        } catch {
          /* best-effort per player */
        }
        advance('Following session players…')
      }
    }

    // 3 + 4. Same label and sister imprints.
    if (routeEnabled('label')) {
      // 3. Same label.
      for (const label of seed.labels || []) {
        if (!label.id) continue
        try {
          const { releases = [] } = await discogs.getLabelReleases(label.id)
          push({
            id: `label:${label.id}`,
            type: 'label',
            title: label.name,
            pool: buildPool(
              releases,
              { seed, store, base: 70, why: `Same label — ${label.name}`, fromArtist: false, keep, rankOwnedEqually },
              poolSize
            )
          })
        } catch {
          /* best-effort per label */
        }
        advance('Reading label catalogue…')
      }

      // 4. Sub-label family — sister imprints only.
      // NB: we deliberately do NOT expand the *parent* label: for an imprint signed
      // to a major, the parent is a genre-spanning distributor (the "Sugababes →
      // Nirvana" problem). Sub-labels are tight, same-family imprints.
      for (const label of seed.labels || []) {
        if (!label.id) continue
        const info = await discogs.getLabel(label.id).catch(() => null)
        const family = (info?.sublabels || []).slice(0, 3)
        for (const sub of family) {
          if (!sub.id) continue
          try {
            const { releases = [] } = await discogs.getLabelReleases(sub.id)
            push({
              id: `sublabel:${sub.id}`,
              type: 'label',
              title: sub.name,
              pool: buildPool(
                releases,
                { seed, store, base: 58, why: `Sister label — ${sub.name}`, fromArtist: false, keep, rankOwnedEqually },
                poolSize
              )
            })
          } catch {
            /* best-effort per sub-label */
          }
        }
        advance('Checking sister labels…')
      }
    }

    // 7. Compilation co-appearance — other tracks from comps the seed appears on.
    const artistId = (seed.artists || [])[0]?.id
    if (artistId && routeEnabled('comp')) {
      try {
        const { releases = [] } = await discogs.getArtistReleases(artistId)
        const comps = releases
          .filter((r) => r.type === 'release' && (r.role === 'Appearance' || /comp/i.test(r.format || '')))
          .slice(0, 2)
        const seen = new Set([seedKey])
        const pool: Candidate[] = []
        for (const comp of comps) {
          if (!comp.id) continue
          const rel = await discogs.getRelease(comp.id).catch(() => null)
          if (!rel) continue
          for (const tr of rel.tracklist || []) {
            const a =
              (tr.artists || []).map((x) => x.name).join(', ') ||
              (rel.artists || []).map((x) => x.name).join(', ')
            if (!a || !tr.title) continue
            const key = dedupKey(a, tr.title)
            const label = (rel.labels || [])[0]?.name || null
            const year = rel.year || null
            if (seen.has(key) || !keep({ artist: a, title: tr.title, year, label })) continue
            seen.add(key)
            pool.push(applyOwned({
              key, artist: a, title: tr.title, label, year,
              discogs_id: rel.id, why: `Same compilation — ${rel.title}`, score: 45
            }, store, rankOwnedEqually))
          }
        }
        push({ id: 'comp', type: 'comp', title: 'SAME COMPILATION', pool: pool.slice(0, poolSize) })
        advance('Scanning compilations…')
      } catch {
        /* compilation route is best-effort */
      }
    }
  })()

  // ── 5. Listeners-also (Last.fm) — own host, runs concurrently. ──
  const listenerWork = (async (): Promise<void> => {
    if (!(lastfm && routeEnabled('listener'))) return
    try {
      const sim = await lastfm.similarTracks(seed.artist, seed.title, poolSize)
      const seen = new Set([seedKey])
      const pool: Candidate[] = []
      for (const t of sim) {
        const key = dedupKey(t.artist, t.title)
        if (seen.has(key) || !keep({ artist: t.artist, title: t.title, year: null, label: null })) continue
        seen.add(key)
        pool.push(applyOwned({
          key, artist: t.artist, title: t.title, label: null, year: null,
          discogs_id: null, why: 'Listeners of your seed also play this',
          score: Math.round((t.match || 0) * 100)
        }, store, rankOwnedEqually))
      }
      push({ id: 'listener', type: 'listener', title: 'LISTENERS ALSO', pool })
    } catch {
      /* listener route is best-effort */
    } finally {
      advance('Asking Last.fm…')
    }
  })()

  // ── 5b. Sounds-like (Deezer related artists) — own host, concurrent, keyless. ──
  // One sub-branch PER related artist (e.g. "Four Tet", "Daniel Avery") rather
  // than a single pooled "SOUNDS LIKE" — the sonic matches are the strongest the
  // engine produces, so giving each its own branch densifies the web.
  const deezerWork = (async (): Promise<void> => {
    if (!(deezer && routeEnabled('deezer'))) return
    try {
      const groups = await deezer.relatedArtistGroups(seed.artist, seed.title)
      for (const g of groups) {
        const seen = new Set([seedKey])
        const pool: Candidate[] = []
        for (const t of g.tracks) {
          const key = dedupKey(t.artist, t.title)
          if (seen.has(key) || !keep({ artist: t.artist, title: t.title, year: null, label: null }))
            continue
          seen.add(key)
          pool.push(
            applyOwned(
              {
                key, artist: t.artist, title: t.title, label: null, year: null,
                discogs_id: null,
                why: `${g.name} — related to ${seed.artist} on Deezer`,
                score: 80 + Math.round((g.weight || 0) * 8)
              },
              store,
              rankOwnedEqually
            )
          )
        }
        push({ id: `deezer:${g.id}`, type: 'deezer', title: g.name, pool: pool.slice(0, poolSize) })
      }
    } catch {
      /* sonic route is best-effort */
    } finally {
      advance('Asking Deezer…')
    }
  })()

  // ── 6. Sample / cover / remix lineage (MusicBrainz) — own host, concurrent. ──
  const sampleWork = (async (): Promise<void> => {
    if (!(identity && routeEnabled('sample'))) return
    try {
      const mbid = await identity.recordingByArtistTitle({ artist: seed.artist, title: seed.title })
      if (mbid) {
        const rels = await identity.relatedRecordings(mbid)
        const seen = new Set([seedKey])
        const pool: Candidate[] = []
        for (const r of rels) {
          if (!r.artist || !r.title) continue
          const key = dedupKey(r.artist, r.title)
          if (seen.has(key) || !keep({ artist: r.artist, title: r.title, year: null, label: null })) continue
          seen.add(key)
          pool.push(applyOwned({
            key, artist: r.artist, title: r.title, label: null, year: null,
            discogs_id: null, why: `Sample / version lineage — ${r.type}`, score: 90
          }, store, rankOwnedEqually))
        }
        push({ id: 'sample', type: 'sample', title: 'SAMPLE LINEAGE', pool: pool.slice(0, poolSize) })
      }
    } catch {
      /* relations route is best-effort */
    } finally {
      advance('Tracing samples…')
    }
  })()

  // ── 8. DJ-set co-play (1001Tracklists) — own host, concurrent. ──
  const setWork = (async (): Promise<void> => {
    if (!(tracklists && routeEnabled('set'))) return
    try {
      const co = await tracklists.coPlayed({ artist: seed.artist, title: seed.title }, poolSize)
      const seen = new Set([seedKey])
      const pool: Candidate[] = []
      for (const t of co) {
        const key = dedupKey(t.artist, t.title)
        if (seen.has(key) || !keep({ artist: t.artist, title: t.title, year: null, label: null })) continue
        seen.add(key)
        pool.push(applyOwned({
          key, artist: t.artist, title: t.title, label: null, year: null,
          discogs_id: null, why: 'Played alongside your seed in DJ sets',
          score: 74 + (t.weight || 0)
        }, store, rankOwnedEqually))
      }
      push({ id: 'set', type: 'set', title: 'PLAYED ALONGSIDE', pool })
    } catch {
      /* co-play route is best-effort */
    } finally {
      advance('Checking DJ sets…')
    }
  })()

  // ── 9. SoundCloud related tracks (opt-in) — own host, concurrent. The richest
  //    source for unofficial edits / bootlegs / underground nothing else carries.
  const soundcloudWork = (async (): Promise<void> => {
    if (!(soundcloud && routeEnabled('soundcloud'))) return
    try {
      const rel = await soundcloud.relatedTracks(seed.artist, seed.title, poolSize)
      const seen = new Set([seedKey])
      const pool: Candidate[] = []
      for (const t of rel) {
        const key = dedupKey(t.artist, t.title)
        if (seen.has(key) || !keep({ artist: t.artist, title: t.title, year: null, label: null })) continue
        seen.add(key)
        pool.push(applyOwned({
          key, artist: t.artist, title: t.title, label: null, year: null,
          discogs_id: null, why: 'Related on SoundCloud — edits, bootlegs, underground',
          score: 78
        }, store, rankOwnedEqually))
      }
      push({ id: 'soundcloud', type: 'soundcloud', title: 'SOUNDCLOUD', pool })
    } catch {
      /* soundcloud route is best-effort */
    } finally {
      advance('Asking SoundCloud…')
    }
  })()

  await Promise.all([discogsWork, listenerWork, deezerWork, sampleWork, setWork, soundcloudWork])

  // Drop cross-branch duplicates (a track keeps a slot only in its strongest
  // branch), then surface the strongest branches first and cap the count.
  // Dedup can empty a branch, so filter empties before sorting.
  dedupeAcrossDirections(directions)
  const top = directions
    .filter((d) => d.pool.length)
    .sort((a, b) => (b.pool[0]?.score || 0) - (a.pool[0]?.score || 0))
    .slice(0, maxDirections)

  for (const d of top) {
    for (const c of d.pool) {
      store.upsertCandidate({ ...c, direction: d.id, seed_key: seedKey, root_seed_key: rootSeedKey })
    }
  }

  onProgress?.({ done: total, total, label: 'done' })

  return {
    seed: { key: seedKey, artist: seed.artist, title: seed.title, year: seed.year || null, rootSeedKey },
    directions: top.map((d) => ({ id: d.id, type: d.type as RouteType, title: d.title, pool: d.pool }))
  }
}
