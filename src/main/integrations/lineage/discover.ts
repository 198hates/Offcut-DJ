// Discovery returns the seed's relationships grouped into DIRECTIONS (branches),
// each with a ranked POOL the UI windows to 5 and shuffles through. Routes:
//   remix/producer · shared players · same label · sub-label family ·
//   listeners-also (Last.fm) · sample lineage (MusicBrainz) ·
//   same compilation (Discogs) · played-alongside (1001Tracklists)
// Each pooled candidate is persisted tagged with its direction + seed-chain so a
// promoted sub-seed still traces back to the origin.

import { dedupKey } from './store'
import type { LineageStore } from './store'
import type { DiscogsClient, DiscogsReleaseSummary } from './discogs'
import type { Identity } from './identity'
import type { LastfmClient } from './lastfm'
import type { TracklistsClient } from './tracklists'
import type {
  Candidate,
  Direction,
  DiscoverFilters,
  DiscoverOptions,
  DiscoverProgress,
  DiscoverResult,
  RouteType,
  Seed
} from './types'

/** Optional data sources; each route is skipped when its client is absent. */
export interface DiscoverClients {
  lastfm?: LastfmClient | null
  identity?: Identity | null
  tracklists?: TracklistsClient | null
}

// Discogs formats release/result titles as "Artist - Title".
function splitTitle(t = ''): { artist: string; title: string } {
  const i = t.indexOf(' - ')
  return i === -1 ? { artist: '', title: t } : { artist: t.slice(0, i), title: t.slice(i + 3) }
}

// All routes score on a shared 0–100 scale so directions rank by how reliably
// the relationship tracks the seed's *sound*, not by which formula produced the
// number. Era proximity is a gentle nudge, not a genre signal.
function scoreFor(rel: { year?: number | null }, seed: Seed, base: number): number {
  const eraGap = seed.year && rel.year ? Math.abs(seed.year - rel.year) : 99
  const eraBonus = eraGap <= 2 ? 6 : eraGap <= 5 ? 3 : 0
  return base + eraBonus
}

/**
 * A reusable candidate gate built from the user's filters. Used by every route
 * (Discogs pools and the inline listener/sample/comp/set pools) so the filter
 * behaviour is identical everywhere.
 *
 * - owned: excluded unless `includeOwned` is on.
 * - year:  candidates with no year always pass (era is often unknown); only
 *          dated candidates outside [yearMin, yearMax] are dropped.
 * - label: when a labelQuery is set, only candidates whose label contains it
 *          survive (so listener/sample results with no label are dropped — a
 *          label filter is an explicit "I want this imprint" intent).
 */
type CandidateLike = { artist: string; title: string; year: number | null; label: string | null }

function makeKeep(filters: DiscoverFilters, store: LineageStore): (c: CandidateLike) => boolean {
  const labelQ = filters.labelQuery?.trim().toLowerCase() || null
  return (c) => {
    if (!filters.includeOwned && store.owns(c.artist, c.title)) return false
    if (filters.yearMin != null && c.year != null && c.year < filters.yearMin) return false
    if (filters.yearMax != null && c.year != null && c.year > filters.yearMax) return false
    if (labelQ && (!c.label || !c.label.toLowerCase().includes(labelQ))) return false
    return true
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
}

// Discogs release summaries -> one direction's ranked, deduped, filtered pool.
function buildPool(
  releases: DiscogsReleaseSummary[],
  { seed, base, why, fromArtist, keep }: PoolContext,
  poolSize: number
): Candidate[] {
  const seen = new Set([dedupKey(seed.artist, seed.title)])
  const out: Candidate[] = []
  for (const rel of releases) {
    const parsed = splitTitle(rel.title)
    const artist = fromArtist ? parsed.artist || rel.artist || '' : rel.artist || ''
    const title = fromArtist ? parsed.title : rel.title
    if (!artist || !title) continue
    const key = dedupKey(artist, title)
    if (seen.has(key)) continue
    const label = rel.label || null
    const year = rel.year || null
    if (!keep({ artist, title, year, label })) continue
    seen.add(key)
    out.push({
      key,
      artist,
      title,
      label,
      year,
      discogs_id: rel.id || null,
      why,
      score: scoreFor(rel, seed, base)
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, poolSize)
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
  const { lastfm = null, identity = null, tracklists = null } = clients
  const poolSize = opts.poolSize ?? 24
  const maxDirections = opts.maxDirections ?? 8
  const filters = opts.filters ?? {}
  const keep = makeKeep(filters, store)
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
    (routeEnabled('remix') ? persons.length : 0) +
      (routeEnabled('players') ? playerList.length : 0) +
      (routeEnabled('label') ? labelList.length : 0) /* same-label */ +
      (routeEnabled('label') ? labelList.length : 0) /* sister-label sweep */ +
      (lastfm && routeEnabled('listener') ? 1 : 0) +
      (identity && routeEnabled('sample') ? 1 : 0) +
      (seedArtistId && routeEnabled('comp') ? 1 : 0) +
      (tracklists && routeEnabled('set') ? 1 : 0),
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
              { seed, store, base: 94, why: `${p.name} (credited on your seed) also worked on this`, fromArtist: true, keep },
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
              { seed, store, base: 86, why: `Shares a player — ${p.name}${p.role ? ` (${p.role})` : ''}`, fromArtist: true, keep },
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
              { seed, store, base: 70, why: `Same label — ${label.name}`, fromArtist: false, keep },
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
                { seed, store, base: 58, why: `Sister label — ${sub.name}`, fromArtist: false, keep },
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
            pool.push({
              key, artist: a, title: tr.title, label, year,
              discogs_id: rel.id, why: `Same compilation — ${rel.title}`, score: 45
            })
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
        pool.push({
          key, artist: t.artist, title: t.title, label: null, year: null,
          discogs_id: null, why: 'Listeners of your seed also play this',
          score: Math.round((t.match || 0) * 100)
        })
      }
      push({ id: 'listener', type: 'listener', title: 'LISTENERS ALSO', pool })
    } catch {
      /* listener route is best-effort */
    } finally {
      advance('Asking Last.fm…')
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
          pool.push({
            key, artist: r.artist, title: r.title, label: null, year: null,
            discogs_id: null, why: `Sample / version lineage — ${r.type}`, score: 90
          })
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
        pool.push({
          key, artist: t.artist, title: t.title, label: null, year: null,
          discogs_id: null, why: 'Played alongside your seed in DJ sets',
          score: 74 + (t.weight || 0)
        })
      }
      push({ id: 'set', type: 'set', title: 'PLAYED ALONGSIDE', pool })
    } catch {
      /* co-play route is best-effort */
    } finally {
      advance('Checking DJ sets…')
    }
  })()

  await Promise.all([discogsWork, listenerWork, sampleWork, setWork])

  // Surface the strongest branches first; cap the count.
  directions.sort((a, b) => (b.pool[0]?.score || 0) - (a.pool[0]?.score || 0))
  const top = directions.slice(0, maxDirections)

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
