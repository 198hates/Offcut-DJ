/**
 * Lineage — the "dig engine".
 *
 * Given a seed track (a library selection or a typed artist + title), the
 * main-process engine enriches it (label + credits via Discogs) and discovers
 * its relationships grouped into typed DIRECTIONS (branches): remix/producer,
 * shared players, label & sister labels, listeners-also, sample lineage,
 * compilations and DJ-set co-play. Each branch holds a ranked pool the viewer
 * windows to 5 and shuffles; promoting a track ("DIG") chains a new sub-seed,
 * with a now-playing sine wave tracing the path home to ORIGIN.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useToastStore } from '../../store/toastStore'
import { createLineageWeb, type HydrateFn, type LineageWebController, type SelNode } from '../../lib/lineageWeb'
import { acceptsTrackDrop, readTrackIds } from '../../lib/trackDrag'
import { hashHue } from '../../lib/format'
import type {
  BandcampEmbed,
  DiscoverFilters,
  DiscoverResult,
  EnrichInput,
  LineageStatus,
  PreviewResult,
  RouteType,
  SeedCandidate,
  StoredCandidate,
  Track,
  AiDigResult
} from '@shared/types'
import { useAiStatus } from '../../hooks/useAiStatus'
import './lineage.css'

type Phase = 'idle' | 'working' | 'ready' | 'error'

const LEGEND: { type: RouteType; label: string; varName: string }[] = [
  { type: 'remix', label: 'remix / producer', varName: '--orange' },
  { type: 'players', label: 'shared players', varName: '--silver' },
  { type: 'label', label: 'label & sister labels', varName: '--lime' },
  { type: 'listener', label: 'listeners also play', varName: '--teal' },
  { type: 'sample', label: 'sample lineage', varName: '--blue' },
  { type: 'comp', label: 'same compilation', varName: '--orchid' },
  { type: 'set', label: 'played alongside', varName: '--amber' }
]

const ALL_ROUTES: RouteType[] = LEGEND.map((l) => l.type)
const LS_ROUTES = 'offcut-lineage-routes'

function loadEnabledRoutes(): Set<RouteType> {
  try {
    const raw = localStorage.getItem(LS_ROUTES)
    if (raw) {
      const arr = JSON.parse(raw) as RouteType[]
      if (Array.isArray(arr)) return new Set(arr.filter((r) => ALL_ROUTES.includes(r)))
    }
  } catch {
    /* ignore */
  }
  return new Set(ALL_ROUTES)
}

function humanizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/rate limit|429/i.test(msg)) return 'Discogs rate limit hit — wait a moment, or add a token in Settings.'
  return msg || 'Something went wrong.'
}

/** Deterministic gradient for the panel art when no cover is available. */
function gradientFromId(id: string): [string, string] {
  const a = hashHue(id)
  return [`hsl(${a} 42% 26%)`, `hsl(${(a + 48) % 360} 38% 16%)`]
}

export function LineagePage(): JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const show = useToastStore((s) => s.show)

  const [phase, setPhase] = useState<Phase>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<LineageStatus>({ hasToken: true, hasLastfm: false, hasTracklists: false })

  const [artist, setArtist] = useState('')
  const [title, setTitle] = useState('')

  // Seed disambiguation picker + library seed search (Phase 1 search).
  const [seedOptions, setSeedOptions] = useState<SeedCandidate[] | null>(null)
  const [seedSearching, setSeedSearching] = useState(false)
  const [libQuery, setLibQuery] = useState('')

  // Phase 2 — dig filters (route toggles, year range, label, include-owned).
  const [enabledRoutes, setEnabledRoutes] = useState<Set<RouteType>>(loadEnabledRoutes)
  const [yearMin, setYearMin] = useState('')
  const [yearMax, setYearMax] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [includeOwned, setIncludeOwned] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<DiscoverFilters>({})

  const [result, setResult] = useState<DiscoverResult | null>(null)
  const [selected, setSelected] = useState<SelNode | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [bandcamp, setBandcamp] = useState<BandcampEmbed | null>(null)
  const [bandcampLoading, setBandcampLoading] = useState(false)

  // AI crate-dig context (web-grounded).
  const aiEnabled = useAiStatus()
  const [aiDig, setAiDig] = useState<{ key: string; data: AiDigResult } | null>(null)
  const [aiDigBusy, setAiDigBusy] = useState(false)
  const [aiDigError, setAiDigError] = useState<string | null>(null)
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [savedFinds, setSavedFinds] = useState<StoredCandidate[]>([])
  const [listMode, setListMode] = useState<'directions' | 'saved'>('directions')
  const [dropping, setDropping] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)

  // Phase 3 — searchable crate (filters the saved finds, client-side & instant).
  const [crateQuery, setCrateQuery] = useState('')
  const [crateRoute, setCrateRoute] = useState<RouteType | 'all'>('all')
  const [crateSort, setCrateSort] = useState<'score' | 'recent' | 'artist'>('score')

  const stageRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<LineageWebController | null>(null)
  const selectedRef = useRef<SelNode | null>(null)
  const seedMetaRef = useRef<{ bpm: number | null; key: string | null } | null>(null)

  // Build the wire DiscoverFilters from UI state; mirror into a ref so sub-seed
  // digs (fired from the graph controller, which is created once) read current
  // filters without re-mounting the graph. Persist route choices across sessions.
  const discoverFilters = useMemo<DiscoverFilters>(() => {
    const routes = enabledRoutes.size >= ALL_ROUTES.length ? undefined : [...enabledRoutes]
    const ymin = parseInt(yearMin, 10)
    const ymax = parseInt(yearMax, 10)
    return {
      routes,
      yearMin: Number.isFinite(ymin) ? ymin : null,
      yearMax: Number.isFinite(ymax) ? ymax : null,
      labelQuery: labelFilter.trim() || null,
      includeOwned
    }
  }, [enabledRoutes, yearMin, yearMax, labelFilter, includeOwned])

  useEffect(() => {
    filtersRef.current = discoverFilters
    try {
      localStorage.setItem(LS_ROUTES, JSON.stringify([...enabledRoutes]))
    } catch {
      /* ignore */
    }
  }, [discoverFilters, enabledRoutes])

  const toggleRoute = useCallback((type: RouteType) => {
    setEnabledRoutes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  // ── Library lookup for BPM/key hydration ────────────────────────────────────
  const hydrate = useMemo<HydrateFn>(() => {
    const map = new Map<string, { bpm: number | null; key: string | null }>()
    for (const t of tracks) {
      map.set(`${t.artist.toLowerCase()} ${t.title.toLowerCase()}`, { bpm: t.bpm, key: t.key })
    }
    return (a, ti) => map.get(`${a.toLowerCase()} ${ti.toLowerCase()}`) ?? null
  }, [tracks])
  const hydrateRef = useRef(hydrate)
  hydrateRef.current = hydrate

  const selectedTrack: Track | null = useMemo(() => {
    if (selectedTrackIds.size !== 1) return null
    const id = [...selectedTrackIds][0]
    return tracks.find((t) => t.id === id) ?? null
  }, [selectedTrackIds, tracks])

  // ── Saved finds ("the crate") — persisted in lineage.db across sessions ──────
  const refreshSaved = useCallback(async () => {
    try {
      const finds = await window.api.lineage.listSaved()
      setSavedFinds(finds)
      setSavedKeys(new Set(finds.map((c) => c.key)))
    } catch {
      /* ignore */
    }
  }, [])

  // ── Mount: check route status, refresh dedup, load saved, prefill selection ──
  useEffect(() => {
    window.api.lineage.status().then(setStatus).catch(() => {})
    window.api.lineage.reloadLibrary().catch(() => {})
    refreshSaved()
  }, [refreshSaved])

  // Live discovery progress (drives the loading bar).
  useEffect(() => {
    const off = window.api.lineage.onProgress((p) => setProgress(p))
    return off
  }, [])

  useEffect(() => {
    if (selectedTrack && phase === 'idle' && !artist && !title) {
      setArtist(selectedTrack.artist)
      setTitle(selectedTrack.title)
    }
  }, [selectedTrack, phase, artist, title])

  // ── Selection → panel + lazy preview hydration ──────────────────────────────
  const handleSelect = useCallback((node: SelNode | null) => {
    selectedRef.current = node
    setSelected(node)
    setPreview(null)
    setBandcamp(null)
    if (!node || node.kind !== 'track' || !node.artist) {
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    window.api.lineage
      .preview({ artist: node.artist, title: node.title })
      .then((p) => {
        if (selectedRef.current?.id === node.id) setPreview(p)
        // Backfill BPM onto the card from the Deezer match (discovered tracks
        // aren't in the library, so there's nothing to hydrate locally).
        if (p.bpm != null) controllerRef.current?.setMeta(node.id, { bpm: p.bpm })
      })
      .catch(() => {})
      .finally(() => {
        if (selectedRef.current?.id === node.id) setPreviewLoading(false)
      })
  }, [])

  // ── Sub-seed dig (enrich + discover), preserving the origin root key ─────────
  const digSub = useCallback(
    async (a: string, ti: string, rootSeedKey: string): Promise<DiscoverResult | null> => {
      setProgress({ done: 0, total: 1, label: `enriching "${ti}"…` })
      try {
        const s = await window.api.lineage.enrich({ artist: a, title: ti })
        if (!s) return null
        return await window.api.lineage.discover(s, { rootSeedKey, filters: filtersRef.current })
      } finally {
        setProgress(null)
      }
    },
    []
  )

  // ── Mount the stage controller when a fresh result lands ─────────────────────
  useEffect(() => {
    if (!result || !stageRef.current) return
    const ctrl = createLineageWeb(stageRef.current, {
      result,
      seedMeta: seedMetaRef.current,
      hydrate: (a, ti) => hydrateRef.current(a, ti),
      dig: digSub,
      onSelect: handleSelect,
      getPreviewUrl: async (a, ti) => {
        try {
          const p = await window.api.lineage.preview({ artist: a, title: ti })
          return p.previewUrl
        } catch {
          return null
        }
      },
      onStatus: (msg) => setStatusMsg(msg ?? '')
    })
    controllerRef.current = ctrl
    return () => {
      ctrl.destroy()
      controllerRef.current = null
    }
  }, [result, digSub, handleSelect])

  // ── Top-level dig ────────────────────────────────────────────────────────────
  // Core: enrich whatever seed input we were given (typed artist/title, or a
  // specific Discogs release id picked from the disambiguation list), then run
  // discovery. `displayTitle` is only for the success toast.
  const runDig = useCallback(
    async (
      input: EnrichInput,
      displayTitle: string,
      meta?: { bpm: number | null; key: string | null }
    ) => {
      seedMetaRef.current = meta ?? null
      setSeedOptions(null)
      setError(null)
      setSelected(null)
      setPreview(null)
      setBandcamp(null)
      setResult(null)
      setSavedKeys(new Set())
      setPhase('working')
      setStatusMsg('enriching seed — reading Discogs credits…')
      setProgress({ done: 0, total: 1, label: 'enriching seed…' })
      try {
        const s = await window.api.lineage.enrich(input)
        if (!s) {
          setError('Couldn’t find that release on Discogs. Try a more specific artist + title.')
          setPhase('error')
          return
        }
        setStatusMsg('discovering — following credits, labels, listeners & sets…')
        const res = await window.api.lineage.discover(s, { filters: filtersRef.current })
        if (!res.directions.length) {
          setError('No directions surfaced — try a seed with richer Discogs credits.')
          setPhase('error')
          return
        }
        setResult(res)
        setPhase('ready')
        const n = res.directions.length
        show(`Opened ${n} direction${n === 1 ? '' : 's'} from "${displayTitle || s.title}"`, 'success')
      } catch (e) {
        setError(humanizeError(e))
        setPhase('error')
      } finally {
        setProgress(null)
      }
    },
    [show]
  )

  const dig = useCallback(
    (a: string, ti: string, meta?: { bpm: number | null; key: string | null }) => {
      const aTrim = a.trim()
      const tiTrim = ti.trim()
      if (!aTrim && !tiTrim) {
        setError('Enter an artist and title to dig.')
        return
      }
      void runDig({ artist: aTrim, title: tiTrim }, tiTrim || aTrim, meta)
    },
    [runDig]
  )

  // AI dig: web-grounded crate-digging context for the selected node.
  const runAiDig = useCallback(
    async (a: string, ti: string) => {
      const artist = (a || '').trim()
      const title = (ti || '').trim()
      if (!artist && !title) return
      const key = `${artist} ${title}`
      setAiDigBusy(true)
      setAiDigError(null)
      setAiDig(null)
      try {
        const { result, error } = await window.api.ai.digContext({ artist, title })
        if (error || !result) setAiDigError(error ?? 'No context found.')
        else setAiDig({ key, data: result })
      } catch (e) {
        setAiDigError((e as Error).message)
      } finally {
        setAiDigBusy(false)
      }
    },
    []
  )

  // Dig from a specific Discogs release the user picked in the disambiguation list.
  const digRelease = useCallback(
    (c: SeedCandidate) => {
      setArtist(c.artist)
      setTitle(c.title)
      void runDig({ discogsReleaseId: c.releaseId }, c.title || c.raw)
    },
    [runDig]
  )

  // "Choose release" — fetch the top Discogs matches so the user can confirm
  // which one to build the dig on, instead of trusting the first hit.
  const chooseRelease = useCallback(async () => {
    const aTrim = artist.trim()
    const tiTrim = title.trim()
    if (!aTrim && !tiTrim) {
      setError('Enter an artist and title to search.')
      return
    }
    setError(null)
    setSeedSearching(true)
    setSeedOptions(null)
    try {
      const opts = await window.api.lineage.searchSeeds({ artist: aTrim, title: tiTrim })
      if (!opts.length) {
        setError('No Discogs releases matched. Try a different spelling.')
      } else {
        setSeedOptions(opts)
      }
    } catch (e) {
      setError(humanizeError(e))
    } finally {
      setSeedSearching(false)
    }
  }, [artist, title])

  // Seed-from-library: live filter over owned tracks so a dig can start from
  // something you already have (BPM/key travel with it for harmonic hints).
  const libMatches = useMemo(() => {
    const q = libQuery.trim().toLowerCase()
    if (!q) return []
    return tracks
      .filter((t) => `${t.artist} ${t.title}`.toLowerCase().includes(q))
      .slice(0, 8)
  }, [libQuery, tracks])

  const newDig = useCallback(() => {
    setPhase('idle')
    setResult(null)
    setSelected(null)
    setPreview(null)
    setBandcamp(null)
  }, [])

  // ── Drag a library track onto the stage → dig from it ────────────────────────
  const onStageDragOver = useCallback((e: React.DragEvent) => {
    if (!acceptsTrackDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }, [])
  const onStageDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
  }, [])
  const onStageDrop = useCallback(
    (e: React.DragEvent) => {
      if (!acceptsTrackDrop(e)) return
      e.preventDefault()
      setDropping(false)
      const ids = readTrackIds(e)
      const t = ids.length ? tracks.find((x) => x.id === ids[0]) : null
      if (!t) return
      setArtist(t.artist)
      setTitle(t.title)
      dig(t.artist, t.title, { bpm: t.bpm, key: t.key })
    },
    [tracks, dig]
  )

  // ── Save / dismiss / export ─────────────────────────────────────────────────
  const saveSelected = useCallback(async () => {
    const n = selected
    if (!n || n.kind !== 'track' || !n.candidateKey) return
    await window.api.lineage.save(n.candidateKey)
    setSavedKeys((prev) => new Set(prev).add(n.candidateKey as string))
    await refreshSaved()
    show(`Saved "${n.title}" — ${savedFinds.length + 1} in the crate`, 'success')
  }, [selected, show, refreshSaved, savedFinds.length])

  const dismissSelected = useCallback(async () => {
    const n = selected
    if (!n || n.kind !== 'track' || !n.candidateKey) return
    await window.api.lineage.dismiss(n.candidateKey)
    setSavedKeys((prev) => {
      const next = new Set(prev)
      next.delete(n.candidateKey as string)
      return next
    })
    await refreshSaved()
    show(`Dismissed "${n.title}"`, 'info')
  }, [selected, show, refreshSaved])

  const removeSaved = useCallback(
    async (c: StoredCandidate) => {
      await window.api.lineage.dismiss(c.key)
      await refreshSaved()
      show(`Removed "${c.title}" from the crate`, 'info')
    },
    [refreshSaved, show]
  )

  const exportCrate = useCallback(async () => {
    const name = result ? `Lineage · ${result.seed.title}` : 'Lineage'
    const res = await window.api.lineage.exportCrate({ name })
    if (res.saved) show(`Exported ${res.count} finds → ${res.path?.split('/').pop()}`, 'success')
    else if (res.cancelled) {
      /* user cancelled the save dialog */
    } else show(res.error || 'Nothing to export — save some finds first.', 'error')
  }, [result, show])

  const loadBandcamp = useCallback(async () => {
    const n = selectedRef.current
    if (!n || n.kind !== 'track' || !n.artist) return
    setBandcampLoading(true)
    try {
      const emb = await window.api.lineage.bandcampPreview({ artist: n.artist, title: n.title })
      if (selectedRef.current?.id === n.id) {
        if (emb) setBandcamp(emb)
        else show('No Bandcamp match found (search is best-effort).', 'info')
      }
    } catch {
      show('Bandcamp lookup failed.', 'error')
    } finally {
      setBandcampLoading(false)
    }
  }, [show])

  // ── Derived ──────────────────────────────────────────────────────────────────
  const eyebrow =
    selected?.kind === 'dir'
      ? `${selected.type} branch`
      : selected?.kind === 'seed'
        ? selected.isOrigin
          ? 'origin'
          : 'sub-seed'
        : selected
          ? 'track'
          : 'selected'

  const artStyle = useMemo(() => {
    if (preview?.artworkUrl) return { backgroundImage: `url("${preview.artworkUrl}")` }
    const [a, b] = gradientFromId(selected?.id ?? 'seed')
    return { background: `linear-gradient(135deg, ${a}, ${b})` }
  }, [preview, selected])

  const selectedSaved = !!selected?.candidateKey && savedKeys.has(selected.candidateKey)
  const breadcrumb = selected?.lineage?.length ? selected.lineage.join(' › ') : '—'
  const shownBpm = selected?.bpm ?? preview?.bpm ?? null
  const pct = progress && progress.total > 1 ? Math.round((progress.done / progress.total) * 100) : null
  const overlayVisible = phase !== 'ready'
  const activeFilterCount =
    (enabledRoutes.size < ALL_ROUTES.length ? 1 : 0) +
    (yearMin.trim() ? 1 : 0) +
    (yearMax.trim() ? 1 : 0) +
    (labelFilter.trim() ? 1 : 0) +
    (includeOwned ? 1 : 0)

  // Searchable crate — filter + sort the saved finds for the Crate tab.
  const filteredCrate = useMemo(() => {
    const q = crateQuery.trim().toLowerCase()
    let list = savedFinds
    if (q) {
      list = list.filter((c) =>
        `${c.artist} ${c.title} ${c.label ?? ''} ${c.why ?? ''}`.toLowerCase().includes(q)
      )
    }
    if (crateRoute !== 'all') {
      list = list.filter((c) => directionToRoute(c.direction) === crateRoute)
    }
    const sorted = [...list]
    if (crateSort === 'score') sorted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    else if (crateSort === 'recent') sorted.sort((a, b) => (b.found_at || '').localeCompare(a.found_at || ''))
    else sorted.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''))
    return sorted
  }, [savedFinds, crateQuery, crateRoute, crateSort])

  // Routes whose data source is actually live — drives the legend + dig filters.
  // The "played alongside" (1001Tracklists) route has no working source without a
  // partner API, so we hide it rather than offer a toggle that returns nothing.
  const visibleLegend = useMemo(
    () => LEGEND.filter((l) => l.type !== 'set' || status.hasTracklists),
    [status.hasTracklists]
  )

  // Which route types actually appear in the crate — drives the filter dropdown.
  const crateRouteTypes = useMemo(() => {
    const present = new Set<RouteType>()
    for (const c of savedFinds) {
      const r = directionToRoute(c.direction)
      if (r) present.add(r)
    }
    return LEGEND.filter((l) => present.has(l.type))
  }, [savedFinds])

  return (
    <div className="cd-root">
      <div className="cd-app">
        {/* ── Stage ── */}
        <div
          className={`cd-stage${dropping ? ' cd-dropping' : ''}`}
          onDragOver={onStageDragOver}
          onDragLeave={onStageDragLeave}
          onDrop={onStageDrop}
        >
          <div className="cd-topbar">
            <div className="cd-brand">
              Lineage<span className="dot">.</span>
            </div>
            <div className="cd-readout" title="path home to origin">
              <span className="seg">
                {breadcrumb}
                <span className="caret" />
              </span>
              {phase === 'ready' && statusMsg && <span className="cd-statusline">{statusMsg}</span>}
            </div>
            <div className="cd-tools">
              <button className="cd-iconbtn" title="new dig" onClick={newDig} disabled={phase === 'working'}>
                ⌖
              </button>
              <button
                className="cd-iconbtn"
                title="fit to view"
                onClick={() => controllerRef.current?.fit()}
                disabled={phase !== 'ready'}
              >
                ⊕
              </button>
              <button
                className="cd-iconbtn"
                title="reset to origin"
                onClick={() => controllerRef.current?.reset()}
                disabled={phase !== 'ready'}
              >
                ⟲
              </button>
            </div>
          </div>

          <div ref={stageRef} className="cd-cy" />

          {/* Thin progress bar for sub-seed digs (graph already on screen) */}
          {progress && phase === 'ready' && (
            <div className="cd-topprogress">
              <div
                className={`bar ${pct == null ? 'indet' : ''}`}
                style={pct != null ? { width: `${Math.max(6, pct)}%` } : undefined}
              />
            </div>
          )}

          <div className="cd-legend">
            <div className="lt">patch</div>
            {visibleLegend.map((l) => (
              <div className="row" key={l.type}>
                <span className="sw" style={{ background: `var(${l.varName})` }} /> {l.label}
              </div>
            ))}
          </div>

          <div className="cd-hint">VIEW to inspect · DIG↘ to branch · selected node pulses its line home</div>

          {overlayVisible && (
            <div className="cd-overlay">
              <div className="cd-seedcard">
                <h2>Dig a crate</h2>
                <p>
                  Start from a seed track — <strong>drag one in from the library tray below</strong>, use your
                  current selection, or type an artist + title. We&apos;ll read its label &amp; credits from
                  Discogs, then branch out along scene and lineage signals — excluding what you already own.
                </p>

                {selectedTrack && (
                  <button
                    className="cd-useselection"
                    onClick={() => {
                      setArtist(selectedTrack.artist)
                      setTitle(selectedTrack.title)
                      dig(selectedTrack.artist, selectedTrack.title, {
                        bpm: selectedTrack.bpm,
                        key: selectedTrack.key
                      })
                    }}
                    disabled={phase === 'working'}
                  >
                    ▸ Dig from selection — {selectedTrack.artist} – {selectedTrack.title}
                  </button>
                )}

                {/* Seed from your own library — type to filter owned tracks. */}
                <div className="cd-field">
                  <label>from your library</label>
                  <input
                    value={libQuery}
                    onChange={(e) => setLibQuery(e.target.value)}
                    placeholder="search your tracks…"
                  />
                </div>
                {libMatches.length > 0 && (
                  <div className="cd-seedpick">
                    {libMatches.map((t) => (
                      <button
                        key={t.id}
                        className="cd-seedopt"
                        disabled={phase === 'working'}
                        onClick={() => {
                          setLibQuery('')
                          dig(t.artist, t.title, { bpm: t.bpm, key: t.key })
                        }}
                      >
                        <span className="ar">{t.artist || '—'}</span>
                        <span className="ti">{t.title || '—'}</span>
                        <span className="me">
                          {t.bpm ? `${Math.round(t.bpm)}` : ''}
                          {t.key ? ` · ${t.key}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="cd-or">or search Discogs</div>

                <div className="cd-field">
                  <label>artist</label>
                  <input
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                    placeholder="e.g. Floating Points"
                    onKeyDown={(e) => e.key === 'Enter' && dig(artist, title)}
                  />
                </div>
                <div className="cd-field">
                  <label>title</label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Silhouettes"
                    onKeyDown={(e) => e.key === 'Enter' && dig(artist, title)}
                  />
                </div>

                {/* ── Dig filters (Phase 2) ─────────────────────────────────── */}
                <div className="cd-filters">
                  <button
                    className="cd-filters-toggle"
                    onClick={() => setFiltersOpen((o) => !o)}
                    type="button"
                  >
                    <span>
                      filters{activeFilterCount > 0 ? ` · ${activeFilterCount} active` : ''}
                    </span>
                    <span className="chev">{filtersOpen ? '▴' : '▾'}</span>
                  </button>

                  {filtersOpen && (
                    <div className="cd-filters-body">
                      <div className="cd-routes">
                        {visibleLegend.map((l) => (
                          <button
                            key={l.type}
                            type="button"
                            className={`cd-routechip ${enabledRoutes.has(l.type) ? 'on' : 'off'}`}
                            style={{ ['--chip' as string]: `var(${l.varName})` }}
                            onClick={() => toggleRoute(l.type)}
                            title={enabledRoutes.has(l.type) ? 'click to skip this route' : 'click to include this route'}
                          >
                            {l.label}
                          </button>
                        ))}
                      </div>

                      <div className="cd-filtrow">
                        <div className="cd-field sm">
                          <label>year from</label>
                          <input
                            value={yearMin}
                            onChange={(e) => setYearMin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            placeholder="any"
                            inputMode="numeric"
                          />
                        </div>
                        <div className="cd-field sm">
                          <label>year to</label>
                          <input
                            value={yearMax}
                            onChange={(e) => setYearMax(e.target.value.replace(/\D/g, '').slice(0, 4))}
                            placeholder="any"
                            inputMode="numeric"
                          />
                        </div>
                      </div>

                      <div className="cd-field">
                        <label>label contains</label>
                        <input
                          value={labelFilter}
                          onChange={(e) => setLabelFilter(e.target.value)}
                          placeholder="e.g. Ninja Tune"
                        />
                      </div>

                      <label className="cd-checkrow">
                        <input
                          type="checkbox"
                          checked={includeOwned}
                          onChange={(e) => setIncludeOwned(e.target.checked)}
                        />
                        Include tracks already in my library
                      </label>
                    </div>
                  )}
                </div>

                <div className="cd-actions">
                  <button className="cd-go" onClick={() => dig(artist, title)} disabled={phase === 'working'}>
                    {phase === 'working' ? <span className="cd-spinner" /> : null}
                    {phase === 'working' ? 'Digging…' : 'Dig'}
                  </button>
                  <button
                    className="cd-choose"
                    onClick={chooseRelease}
                    disabled={phase === 'working' || seedSearching}
                    title="Pick which Discogs release to build the dig on"
                  >
                    {seedSearching ? 'searching…' : 'choose release…'}
                  </button>
                </div>

                {/* Disambiguation list — confirm which release to dig from. */}
                {seedOptions && (
                  <div className="cd-seedpick cd-discogs">
                    {seedOptions.map((c) => (
                      <button
                        key={c.releaseId}
                        className="cd-seedopt"
                        disabled={phase === 'working'}
                        onClick={() => digRelease(c)}
                      >
                        <span className="ar">{c.artist || c.raw}</span>
                        <span className="ti">{c.title}</span>
                        <span className="me">
                          {[c.year, c.label, c.format, c.country].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {phase === 'working' && (
                  <div className="cd-progress">
                    <div className="cd-progress-track">
                      <div
                        className={`cd-progress-fill ${pct == null ? 'indet' : ''}`}
                        style={pct != null ? { width: `${Math.max(6, pct)}%` } : undefined}
                      />
                    </div>
                    <div className="cd-progress-label">
                      {progress?.label || statusMsg}
                      {pct != null ? ` · ${pct}%` : ''}
                    </div>
                  </div>
                )}

                {error && <div className="cd-note err">{error}</div>}
                {!status.hasToken && phase !== 'working' && (
                  <div className="cd-note warn">
                    No Discogs token set — running unauthenticated (slower). Add a free token in Settings ›
                    Lineage to speed up discovery.
                  </div>
                )}
                {status.hasToken && !status.hasLastfm && phase !== 'working' && (
                  <div className="cd-note">
                    Tip: add a free Last.fm key in Settings › Lineage to light up the “listeners also play” route.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Panel ── */}
        <aside className="cd-panel">
          <div className="cd-detail">
            <div className="cd-art" style={artStyle}>
              {!preview?.artworkUrl && <div className="grv" />}
            </div>
            <div className="cd-eyebrow">
              <span>{eyebrow}</span>
              {selected?.source && <span className="cd-source-tag">via {selected.source}</span>}
            </div>
            <h1>{selected?.title ?? 'Nothing selected'}</h1>
            <div className="artist">
              {selected?.artist ||
                (selected?.kind === 'dir'
                  ? 'a branch — reveal or shuffle its pool'
                  : phase === 'ready'
                    ? 'tap a node to inspect'
                    : 'dig a crate to begin')}
            </div>

            <div className="cd-why">{selected?.why || ''}</div>

            {selected?.kind === 'dir' && selected.dirWindow && (
              <div className="cd-window">
                <div className="meter">
                  WINDOW {String(selected.dirWindow.from).padStart(2, '0')}–
                  {String(selected.dirWindow.to).padStart(2, '0')} / {selected.dirWindow.total}
                </div>
              </div>
            )}

            {selected && selected.kind !== 'dir' && (
              <div className="cd-stats">
                {shownBpm != null && (
                  <div className="cd-stat">
                    <span>BPM</span> {shownBpm}
                  </div>
                )}
                {selected.key && (
                  <div className={`cd-stat ${selected.isHarmonic ? 'match' : ''}`}>
                    <span>KEY</span> {selected.key}
                    {selected.isHarmonic ? ' ✓' : ''}
                  </div>
                )}
                {selected.score != null && (
                  <div className="cd-stat">
                    <span>SCORE</span> {selected.score}
                  </div>
                )}
                {selected.year != null && (
                  <div className="cd-stat">
                    <span>YEAR</span> {selected.year}
                  </div>
                )}
              </div>
            )}

            <div className="cd-actions">
              <button className="cd-btn primary" onClick={saveSelected} disabled={!selected || selected.kind !== 'track'}>
                {selectedSaved ? '✓ Saved' : '＋ Save'}
              </button>
              <button className="cd-btn" onClick={dismissSelected} disabled={!selected || selected.kind !== 'track'}>
                Dismiss
              </button>
              <button className="cd-btn" onClick={exportCrate} disabled={savedKeys.size === 0}>
                Export
              </button>
              {aiEnabled && (
                <button
                  className="cd-btn"
                  onClick={() => selected && runAiDig(selected.artist ?? '', selected.title ?? '')}
                  disabled={aiDigBusy || !selected || (!selected.artist && !selected.title)}
                  title="AI crate-dig context — web-grounded research on this record"
                >
                  {aiDigBusy ? '✦ …' : '✦ AI dig'}
                </button>
              )}
            </div>

            {/* AI crate-dig context */}
            {aiEnabled && (aiDigBusy || aiDigError || aiDig) && (
              <div className="cd-aidig">
                {aiDigBusy && (
                  <div className="cd-note"><span className="cd-spinner" /> researching the web…</div>
                )}
                {!aiDigBusy && aiDigError && (
                  <div className="cd-aidig-err">{aiDigError}</div>
                )}
                {!aiDigBusy && aiDig && (
                  <>
                    <p className="cd-aidig-summary">{aiDig.data.summary}</p>
                    {aiDig.data.suggestions.length > 0 && (
                      <div className="cd-aidig-list">
                        {aiDig.data.suggestions.map((s, i) => (
                          <div key={i} className="cd-aidig-row">
                            <div className="cd-aidig-meta">
                              <span className="cd-aidig-name">
                                {s.artist}{s.title ? ` — ${s.title}` : ''}
                              </span>
                              <span className="cd-aidig-why">{s.why}</span>
                            </div>
                            <button
                              className="cd-btn sm"
                              onClick={() => dig(s.artist, s.title)}
                              title="Dig from this lead"
                            >
                              DIG
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {aiDig.data.sources.length > 0 && (
                      <div className="cd-aidig-src">
                        {aiDig.data.sources.slice(0, 6).map((src, i) => (
                          <a key={i} href={src.url} target="_blank" rel="noreferrer" title={src.url}>
                            ▸ {src.title.length > 40 ? src.title.slice(0, 40) + '…' : src.title}
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Preview / sources */}
            {selected?.kind === 'track' && (
              <>
                {previewLoading && (
                  <div className="cd-note">
                    <span className="cd-spinner" />
                    finding a preview…
                  </div>
                )}
                {!previewLoading && preview?.previewUrl && (
                  <>
                    <audio className="cd-audio" controls autoPlay src={preview.previewUrl} key={selected.id} />
                    {preview.source === 'itunes' && preview.storeUrl && (
                      <a className="cd-store" href={preview.storeUrl} target="_blank" rel="noreferrer">
                        ♫ Preview via Apple Music — view in iTunes Store
                      </a>
                    )}
                  </>
                )}
                <div className="cd-sources">
                  {!previewLoading && !preview?.previewUrl && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>No 30s preview — open externally:</span>
                  )}
                  <button className={`cd-src ${bandcamp ? 'on' : ''}`} onClick={loadBandcamp} disabled={bandcampLoading}>
                    {bandcampLoading ? '…' : '▸ Bandcamp'}
                  </button>
                  {preview?.links?.youtube && (
                    <a className="cd-src" href={preview.links.youtube} target="_blank" rel="noreferrer">
                      ▸ YouTube
                    </a>
                  )}
                  {preview?.links?.soundcloud && (
                    <a className="cd-src" href={preview.links.soundcloud} target="_blank" rel="noreferrer">
                      ▸ SoundCloud
                    </a>
                  )}
                  {selected.discogsId && (
                    <a
                      className="cd-src"
                      href={`https://www.discogs.com/release/${selected.discogsId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ▸ Discogs
                    </a>
                  )}
                </div>
                {bandcamp && <iframe className="cd-bandcamp" title="Bandcamp" src={bandcamp.embedSrc} />}
              </>
            )}
          </div>

          <div className="cd-listwrap">
            <div className="cd-tabs">
              <button
                className={`cd-tab ${listMode === 'directions' ? 'on' : ''}`}
                onClick={() => setListMode('directions')}
              >
                Directions <em>{result?.directions.length ?? 0}</em>
              </button>
              <button
                className={`cd-tab ${listMode === 'saved' ? 'on' : ''}`}
                onClick={() => setListMode('saved')}
              >
                Crate <em>{savedFinds.length}</em>
              </button>
              {savedFinds.length > 0 && (
                <button className="cd-export" onClick={exportCrate} title="Export saved finds to Rekordbox XML">
                  ↑ Export
                </button>
              )}
            </div>

            {listMode === 'directions' && (
              <>
                {result?.directions.map((d) => {
                  const active = selected?.kind === 'dir' && selected.title === d.title
                  return (
                    <div
                      key={d.id}
                      className={`cd-item ${active ? 'active' : ''}`}
                      onClick={() => controllerRef.current?.selectByCandidateKey(d.pool[0]?.key ?? '')}
                    >
                      <div className="sc" style={{ color: `var(--${legendVar(d.type)})` }}>
                        {d.pool.length}
                      </div>
                      <div className="meta">
                        <div className="t">{d.title}</div>
                        <div className="a">{routeLabel(d.type)}</div>
                      </div>
                    </div>
                  )
                })}
                {phase === 'ready' && !result?.directions.length && (
                  <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--muted)' }}>
                    No directions surfaced. Try a different seed, or one with richer Discogs credits.
                  </div>
                )}
              </>
            )}

            {listMode === 'saved' && (
              <>
                {savedFinds.length > 0 && (
                  <div className="cd-cratefilter">
                    <input
                      className="cd-cratesearch"
                      value={crateQuery}
                      onChange={(e) => setCrateQuery(e.target.value)}
                      placeholder="search crate — artist, title, label…"
                    />
                    <div className="cd-craterow">
                      <select
                        value={crateRoute}
                        onChange={(e) => setCrateRoute(e.target.value as RouteType | 'all')}
                      >
                        <option value="all">all routes</option>
                        {crateRouteTypes.map((l) => (
                          <option key={l.type} value={l.type}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={crateSort}
                        onChange={(e) => setCrateSort(e.target.value as 'score' | 'recent' | 'artist')}
                      >
                        <option value="score">score</option>
                        <option value="recent">recent</option>
                        <option value="artist">artist</option>
                      </select>
                    </div>
                    {(crateQuery.trim() || crateRoute !== 'all') && (
                      <div className="cd-cratecount">
                        {filteredCrate.length} of {savedFinds.length}
                        <button
                          className="cd-crateclear"
                          onClick={() => {
                            setCrateQuery('')
                            setCrateRoute('all')
                          }}
                        >
                          clear
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {filteredCrate.map((c) => {
                  const route = directionToRoute(c.direction)
                  return (
                    <div
                      key={c.key}
                      className="cd-item saved"
                      onClick={() => controllerRef.current?.selectByCandidateKey(c.key)}
                    >
                      <div
                        className="sc"
                        style={{ color: route ? `var(--${legendVar(route)})` : 'var(--muted)' }}
                        title={route ? routeLabel(route) : ''}
                      >
                        {c.score != null ? Math.round(c.score) : '•'}
                      </div>
                      <div className="meta">
                        <div className="t">{c.title}</div>
                        <div className="a">{c.artist}{c.year ? ` · ${c.year}` : ''}</div>
                        {c.why && <div className="cd-saved-why">{c.why}</div>}
                      </div>
                      <button
                        className="cd-remove"
                        title="Remove from crate"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSaved(c)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}

                {savedFinds.length > 0 && filteredCrate.length === 0 && (
                  <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    No crate finds match — try a different search or route.
                  </div>
                )}

                {savedFinds.length === 0 && (
                  <div style={{ padding: '12px 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    Your crate is empty. Hit <strong>＋ Save</strong> on a find to add it here — the crate
                    persists across sessions, and <strong>Export</strong> writes it to a Rekordbox XML you can
                    import and go buy.
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function routeLabel(t: RouteType): string {
  return LEGEND.find((l) => l.type === t)?.label ?? t
}
/** Map a stored candidate's `direction` (e.g. "person:123", "label:45") to its route type. */
function directionToRoute(direction?: string | null): RouteType | null {
  if (!direction) return null
  if (direction.startsWith('person:')) return 'remix'
  if (direction.startsWith('player:')) return 'players'
  if (direction.startsWith('label:') || direction.startsWith('sublabel:')) return 'label'
  if (direction === 'listener') return 'listener'
  if (direction === 'sample') return 'sample'
  if (direction === 'comp') return 'comp'
  if (direction === 'set') return 'set'
  return null
}
function legendVar(t: RouteType): string {
  return (LEGEND.find((l) => l.type === t)?.varName ?? '--orange').replace('--', '')
}
