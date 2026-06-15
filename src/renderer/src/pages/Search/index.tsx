/**
 * Search — Advanced Multi-Dimension Search
 *
 * Five range sliders (BPM, Energy, Danceability, Mood, Rating) +
 * Key chips (Camelot), Genre chips, Tag chips, attribute flags.
 *
 * Results update live.  Results can be sent to any playlist
 * or saved as a Smart Playlist.
 *
 * ⌘F / Ctrl+F anywhere in the app navigates here.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore, useDeckBStore } from '../../store/playerStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import { useAiStatus } from '../../hooks/useAiStatus'
import { formatDuration } from '../../lib/format'
import type { Track, SmartRule, AiSearchFilter } from '@shared/types'

// ── Dual-handle range slider ──────────────────────────────────────────────────

function RangeSlider({
  label, min, max, value, onChange, step = 1, fmt = String,
}: {
  label: string; min: number; max: number
  value: [number, number]; onChange: (v: [number, number]) => void
  step?: number; fmt?: (v: number) => string
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [lo, hi] = value
  const span = max - min
  const loFrac = (lo - min) / span
  const hiFrac = (hi - min) / span

  const handleMouse = (thumb: 'lo' | 'hi') =>
    (eDown: React.MouseEvent) => {
      eDown.preventDefault()
      const track = trackRef.current!
      const onMove = (e: MouseEvent) => {
        const rect = track.getBoundingClientRect()
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const raw  = min + frac * span
        const snapped = Math.round(raw / step) * step
        if (thumb === 'lo') onChange([Math.min(snapped, hi), hi])
        else                onChange([lo, Math.max(snapped, lo)])
      }
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{label}</span>
        <span className="font-mono text-[11px] text-ink/60 tabular-nums">
          {fmt(lo)} – {fmt(hi)}
        </span>
      </div>
      <div ref={trackRef} className="relative h-4 flex items-center cursor-pointer select-none">
        {/* Track background */}
        <div className="absolute inset-x-0 h-1 bg-border/30 rounded-full" />
        {/* Active range fill */}
        <div
          className="absolute h-1 rounded-full"
          style={{ left: `${loFrac * 100}%`, width: `${(hiFrac - loFrac) * 100}%`, background: 'rgb(var(--accent-rgb))', opacity: 0.6 }}
        />
        {/* Lo thumb */}
        <div
          className="absolute w-3 h-3 rounded-full border-2 cursor-grab active:cursor-grabbing"
          style={{ left: `calc(${loFrac * 100}% - 6px)`, background: '#1a1612', borderColor: 'rgb(var(--accent-rgb))', zIndex: 2 }}
          onMouseDown={handleMouse('lo')}
        />
        {/* Hi thumb */}
        <div
          className="absolute w-3 h-3 rounded-full border-2 cursor-grab active:cursor-grabbing"
          style={{ left: `calc(${hiFrac * 100}% - 6px)`, background: '#1a1612', borderColor: 'rgb(var(--accent-rgb))', zIndex: 2 }}
          onMouseDown={handleMouse('hi')}
        />
      </div>
    </div>
  )
}

// ── Camelot key grid ──────────────────────────────────────────────────────────

const ALL_KEYS = [
  '1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A',
  '1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B',
]

function KeyGrid({ selected, onToggle }: { selected: Set<string>; onToggle: (k: string) => void }): JSX.Element {
  return (
    <div className="grid grid-cols-6 gap-0.5">
      {ALL_KEYS.map((k) => {
        const on = selected.has(k)
        return (
          <button key={k} onClick={() => onToggle(k)}
            className="font-mono text-[10px] py-0.5 rounded transition-colors"
            style={{
              background: on ? keyBlipColor(k) + '30' : 'rgba(255,255,255,0.03)',
              color: on ? keyBlipColor(k) : 'rgba(180,170,155,0.4)',
              border: `1px solid ${on ? keyBlipColor(k) + '60' : 'transparent'}`,
            }}
          >{k}</button>
        )
      })}
    </div>
  )
}

// ── Search result row ─────────────────────────────────────────────────────────

function ResultRow({ track, onLoadA, onLoadB, onContextMenu }: { track: Track; onLoadA: (t: Track) => void; onLoadB: (t: Track) => void; onContextMenu: (e: React.MouseEvent, t: Track) => void }): JSX.Element {
  const fmt = formatDuration
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b border-border/15 hover:bg-ink/[0.03] group transition-colors"
      onContextMenu={(e) => onContextMenu(e, track)}
    >
      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: keyBlipColor(track.key) }} />
      <div className="flex-1 min-w-0">
        <p className="font-mono text-[13px] text-ink truncate">{track.title || '—'}</p>
        <p className="font-mono text-[11px] text-muted truncate">{track.artist}{track.album ? ` · ${track.album}` : ''}</p>
      </div>
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0 hidden md:block">{track.bpm?.toFixed(1) ?? '—'}</span>
      <span className="font-mono text-[12px] font-bold shrink-0 hidden sm:block" style={{ color: keyBlipColor(track.key) }}>{track.key ?? '—'}</span>
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0 hidden lg:block">{track.energy != null ? `${track.energy}/10` : '—'}</span>
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0 hidden lg:block">{fmt(track.durationSeconds)}</span>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onLoadA(track)} className="font-mono text-[11px] text-accent shrink-0" title="Load deck A">A</button>
        <button onClick={() => onLoadB(track)} className="font-mono text-[11px] text-muted hover:text-ink shrink-0" title="Load deck B">B</button>
      </div>
    </div>
  )
}

// ── SearchPage ────────────────────────────────────────────────────────────────

const MOOD_CATEGORIES = [
  { label: 'Dark',        range: [-1, -0.6] as [number,number], color: '#4a3860' },
  { label: 'Melancholic', range: [-0.6,-0.2] as [number,number], color: '#6e5f8a' },
  { label: 'Neutral',     range: [-0.2, 0.2] as [number,number], color: '#6e6553' },
  { label: 'Uplifting',   range: [0.2,  0.6] as [number,number], color: '#c8904a' },
  { label: 'Euphoric',    range: [0.6,  1.0] as [number,number], color: '#f5c842' },
]

export function SearchPage(): JSX.Element {
  const { tracks, playlists, createSmartPlaylist, addTracksToPlaylist } = useLibraryStore()
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const loadTrackB = useDeckBStore((s) => s.loadTrack)
  const openTrackMenu = useTrackMenuContext()

  // ── Filter state ──────────────────────────────────────────────────────────
  const [bpm,         setBpm]         = useState<[number,number]>([60,  200])
  const [energy,      setEnergy]      = useState<[number,number]>([1,   10])
  const [danceability,setDanceability]= useState<[number,number]>([0,   1])
  const [mood,        setMood]        = useState<[number,number]>([-1,  1])
  const [rating,      setRating]      = useState<[number,number]>([0,   5])
  const [keys,        setKeys]        = useState<Set<string>>(new Set())
  const [genres,      setGenres]      = useState<Set<string>>(new Set())
  const [flags,       setFlags]       = useState({ hasBpm: false, hasKey: false, hasCues: false, hasGrid: false, unplayed: false })
  const [moodCats,    setMoodCats]    = useState<Set<number>>(new Set())
  const [sortBy,      setSortBy]      = useState<'title' | 'bpm' | 'energy' | 'rating'>('title')
  const [showSend,    setShowSend]    = useState(false)
  const [sending,     setSending]     = useState(false)
  const [showOrderSend, setShowOrderSend] = useState(false)
  const [runningOrders, setRunningOrders] = useState<{ id: string; title: string; catalogNum: number }[]>([])

  // ── AI natural-language search ───────────────────────────────────────────
  const [aiQuery,   setAiQuery]   = useState('')
  const aiEnabled = useAiStatus()
  const [aiBusy,    setAiBusy]    = useState(false)
  const [aiNote,    setAiNote]    = useState<string | null>(null)
  const [aiError,   setAiError]   = useState<string | null>(null)

  useEffect(() => {
    window.api.library.getRunningOrders().then((ros) =>
      setRunningOrders(ros.map((r) => ({ id: r.id, title: r.title, catalogNum: r.catalogNum })))
    )
  }, [])

  // ── Available filter options ──────────────────────────────────────────────
  const allGenres = useMemo(() => [...new Set(tracks.map((t) => t.genre).filter(Boolean))].sort(), [tracks])
  const nonFolderPlaylists = useMemo(() => playlists.filter((p) => !p.isFolder && !p.isSmart), [playlists])

  const bpmRange   = useMemo(() => { const v = tracks.map((t) => t.bpm).filter(Boolean) as number[]; return v.length ? [Math.floor(Math.min(...v)), Math.ceil(Math.max(...v))] as [number,number] : [60,200] as [number,number] }, [tracks])

  // ── Apply filters ─────────────────────────────────────────────────────────
  const results = useMemo(() => {
    let r = tracks

    if (bpm[0] > bpmRange[0] || bpm[1] < bpmRange[1])
      r = r.filter((t) => t.bpm != null && t.bpm >= bpm[0] && t.bpm <= bpm[1])
    if (energy[0] > 1 || energy[1] < 10)
      r = r.filter((t) => t.energy != null && t.energy >= energy[0] && t.energy <= energy[1])
    if (danceability[0] > 0 || danceability[1] < 1)
      r = r.filter((t) => t.danceability != null && t.danceability >= danceability[0] && t.danceability <= danceability[1])
    if (mood[0] > -1 || mood[1] < 1)
      r = r.filter((t) => t.mood != null && t.mood >= mood[0] && t.mood <= mood[1])
    if (rating[0] > 0 || rating[1] < 5)
      r = r.filter((t) => t.rating >= rating[0] && t.rating <= rating[1])
    if (keys.size > 0)
      r = r.filter((t) => t.key && keys.has(t.key.toUpperCase()))
    if (genres.size > 0)
      r = r.filter((t) => genres.has(t.genre))
    if (moodCats.size > 0)
      r = r.filter((t) => t.mood != null && [...moodCats].some((i) => t.mood! >= MOOD_CATEGORIES[i].range[0] && t.mood! <= MOOD_CATEGORIES[i].range[1]))
    if (flags.hasBpm)    r = r.filter((t) => t.bpm != null)
    if (flags.hasKey)    r = r.filter((t) => !!t.key)
    if (flags.hasCues)   r = r.filter((t) => t.cuePoints.some((c) => c.type === 'hotcue'))
    if (flags.hasGrid)   r = r.filter((t) => t.beatgrid.length > 0)
    if (flags.unplayed)  r = r.filter((t) => t.playCount === 0)

    return [...r].sort((a, b) => {
      if (sortBy === 'bpm')    return (a.bpm ?? 0) - (b.bpm ?? 0)
      if (sortBy === 'energy') return (b.energy ?? 0) - (a.energy ?? 0)
      if (sortBy === 'rating') return b.rating - a.rating
      return (a.title || '').localeCompare(b.title || '')
    })
  }, [tracks, bpm, bpmRange, energy, danceability, mood, rating, keys, genres, moodCats, flags, sortBy])

  const isFiltered = bpm[0] > bpmRange[0] || bpm[1] < bpmRange[1] ||
    energy[0] > 1 || energy[1] < 10 || danceability[0] > 0 || danceability[1] < 1 ||
    mood[0] > -1 || mood[1] < 1 || rating[0] > 0 || rating[1] < 5 ||
    keys.size > 0 || genres.size > 0 || moodCats.size > 0 ||
    Object.values(flags).some(Boolean)

  const reset = useCallback(() => {
    setBpm([bpmRange[0], bpmRange[1]]); setEnergy([1,10]); setDanceability([0,1])
    setMood([-1,1]); setRating([0,5]); setKeys(new Set()); setGenres(new Set())
    setMoodCats(new Set()); setFlags({ hasBpm:false, hasKey:false, hasCues:false, hasGrid:false, unplayed:false })
  }, [bpmRange])

  // Translate an AI filter into the existing slider/chip/flag state. Nulls leave
  // a dimension at its full range (unconstrained).
  const applyAiFilter = useCallback((f: AiSearchFilter) => {
    reset()
    setBpm([f.bpmMin ?? bpmRange[0], f.bpmMax ?? bpmRange[1]])
    setEnergy([f.energyMin ?? 1, f.energyMax ?? 10])
    setDanceability([f.danceMin ?? 0, f.danceMax ?? 1])
    setMood([f.moodMin ?? -1, f.moodMax ?? 1])
    setRating([f.ratingMin ?? 0, f.ratingMax ?? 5])
    if (f.keys.length) setKeys(new Set(f.keys.map((k) => k.toUpperCase())))
    if (f.genres.length) {
      const valid = new Set(allGenres)
      setGenres(new Set(f.genres.filter((g) => valid.has(g))))
    }
    setFlags({ hasBpm: false, hasKey: false, hasCues: f.hasCues, hasGrid: f.hasGrid, unplayed: f.unplayed })
    setSortBy(f.sortBy)
  }, [reset, bpmRange, allGenres])

  const runAiSearch = useCallback(async () => {
    const q = aiQuery.trim()
    if (!q || aiBusy) return
    setAiBusy(true); setAiError(null); setAiNote(null)
    try {
      const res = await window.api.ai.nlSearch(q, { genres: allGenres, keys: ALL_KEYS })
      if (res.error || !res.filter) { setAiError(res.error ?? 'No result.'); return }
      applyAiFilter(res.filter)
      setAiNote(res.filter.explanation || null)
    } catch (err) {
      setAiError((err as Error).message)
    } finally {
      setAiBusy(false)
    }
  }, [aiQuery, aiBusy, allGenres, applyAiFilter])

  // ── Save as Smart Playlist ────────────────────────────────────────────────
  const saveAsSmartPlaylist = useCallback(async () => {
    const rules: SmartRule[] = []
    if (bpm[0] > bpmRange[0] || bpm[1] < bpmRange[1]) rules.push({ field: 'bpm', op: 'between', value: bpm })
    if (energy[0] > 1 || energy[1] < 10)              rules.push({ field: 'energy', op: 'between', value: energy })
    if (rating[0] > 0 || rating[1] < 5)               rules.push({ field: 'rating', op: 'between', value: rating })
    if (keys.size === 1)  rules.push({ field: 'key', op: 'is', value: [...keys][0] })
    if (genres.size === 1) rules.push({ field: 'genre', op: 'is', value: [...genres][0] })
    if (flags.hasBpm)   rules.push({ field: 'bpm', op: 'greater_than', value: 0 })
    if (flags.unplayed) rules.push({ field: 'playCount', op: 'is', value: '0' })
    const name = `Search · ${new Date().toISOString().slice(0,10)} · ${results.length} tracks`
    await createSmartPlaylist(name, rules)
  }, [bpm, bpmRange, energy, rating, keys, genres, flags, results.length, createSmartPlaylist])

  // ── Send to playlist ──────────────────────────────────────────────────────
  const sendToPlaylist = async (playlistId: string) => {
    setSending(true)
    await addTracksToPlaylist(playlistId, results.map((t) => t.id))
    setSending(false)
    setShowSend(false)
  }

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* ── Filter sidebar ──────────────────────────────────────────────── */}
      <div className="w-56 shrink-0 flex flex-col border-r border-border/30 bg-chassis overflow-y-auto">
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border/30">
          <span className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-accent">Filters</span>
          {isFiltered && (
            <button onClick={reset} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-accent transition-colors">
              clear
            </button>
          )}
        </div>

        <div className="flex-1 px-3 py-3 space-y-4">
          {/* BPM */}
          <RangeSlider label="BPM" min={40} max={220} value={bpm} onChange={setBpm} fmt={(v) => v.toFixed(0)} />

          {/* Energy */}
          <RangeSlider label="Energy" min={1} max={10} value={energy} onChange={setEnergy} fmt={(v) => v.toFixed(0)} />

          {/* Danceability */}
          <RangeSlider label="Danceability" min={0} max={1} step={0.01} value={danceability} onChange={setDanceability}
            fmt={(v) => `${Math.round(v * 100)}%`} />

          {/* Mood */}
          <div>
            <RangeSlider label="Mood" min={-1} max={1} step={0.05} value={mood} onChange={setMood}
              fmt={(v) => (v > 0 ? '+' : '') + v.toFixed(1)} />
            <div className="flex flex-wrap gap-1 mt-1.5">
              {MOOD_CATEGORIES.map((m, i) => {
                const on = moodCats.has(i)
                return (
                  <button key={m.label} onClick={() => setMoodCats((prev) => { const n = new Set(prev); on ? n.delete(i) : n.add(i); return n })}
                    className="font-mono text-[10px] px-1.5 py-0.5 rounded transition-colors"
                    style={{ color: on ? m.color : 'rgba(180,170,155,0.45)', background: on ? m.color + '18' : undefined, border: `1px solid ${on ? m.color + '50' : 'transparent'}` }}>
                    {m.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Rating */}
          <RangeSlider label="Rating" min={0} max={5} value={rating} onChange={setRating}
            fmt={(v) => v === 0 ? 'any' : '★'.repeat(v)} />

          {/* Keys */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Key</span>
              {keys.size > 0 && <button onClick={() => setKeys(new Set())} className="font-mono text-[10px] text-muted/40 hover:text-accent">clear</button>}
            </div>
            <KeyGrid selected={keys} onToggle={(k) => setKeys((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })} />
          </div>

          {/* Genre */}
          {allGenres.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Genre</span>
                {genres.size > 0 && <button onClick={() => setGenres(new Set())} className="font-mono text-[10px] text-muted/40 hover:text-accent">clear</button>}
              </div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {allGenres.map((g) => {
                  const on = genres.has(g)
                  return (
                    <button key={g} onClick={() => setGenres((prev) => { const n = new Set(prev); on ? n.delete(g) : n.add(g); return n })}
                      className={`w-full text-left font-mono text-[12px] px-1.5 py-0.5 rounded truncate transition-colors ${on ? 'bg-accent/10 text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.03]'}`}>
                      {g}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Flags */}
          <div>
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted block mb-1.5">Has</span>
            <div className="space-y-0.5">
              {([['hasBpm','BPM'],['hasKey','Key'],['hasCues','Cue Points'],['hasGrid','Beat Grid'],['unplayed','Unplayed']] as const).map(([k,l]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={flags[k]} onChange={(e) => setFlags((f) => ({...f,[k]:e.target.checked}))}
                    className="accent-accent w-3 h-3" />
                  <span className={`font-mono text-[12px] ${flags[k] ? 'text-ink' : 'text-muted group-hover:text-ink'} transition-colors`}>{l}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Results panel ───────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* AI natural-language search */}
        {aiEnabled && (
          <div className="shrink-0 flex flex-col gap-1 px-4 py-2 border-b border-border/30 bg-ink/[0.02]">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-accent shrink-0" title="AI search">✦</span>
              <input
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runAiSearch() }}
                placeholder="Describe what you want — e.g. “peak-time techno around 130, uplifting, in 8A or 9A”"
                spellCheck={false}
                disabled={aiBusy}
                className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50 disabled:opacity-50"
              />
              <button
                onClick={runAiSearch}
                disabled={aiBusy || !aiQuery.trim()}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent hover:text-ink border border-accent/30 hover:border-accent/60 rounded px-3 py-1.5 transition-colors disabled:opacity-30 shrink-0"
              >
                {aiBusy ? '…' : 'search'}
              </button>
            </div>
            {aiNote && <span className="font-mono text-[11px] text-muted pl-6">{aiNote}</span>}
            {aiError && <span className="font-mono text-[11px] text-red-400/80 pl-6">{aiError}</span>}
          </div>
        )}

        {/* Toolbar */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border/30 bg-chassis">
          <span className="font-mono text-[13px] font-bold text-ink tabular-nums">
            {results.length.toLocaleString()}
            <span className="text-muted font-normal"> track{results.length !== 1 ? 's' : ''} match</span>
          </span>
          <div className="flex-1" />

          {/* Sort */}
          <span className="font-mono text-[11px] text-muted uppercase tracking-[0.1em]">sort</span>
          {(['title','bpm','energy','rating'] as const).map((s) => (
            <button key={s} onClick={() => setSortBy(s)}
              className={`font-mono text-[11px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
                ${sortBy === s ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
              {s}
            </button>
          ))}

          <div className="w-px h-4 bg-border/30" />

          {/* Send to playlist */}
          <div className="relative">
            <button
              onClick={() => setShowSend((v) => !v)}
              disabled={results.length === 0}
              className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 hover:border-border/70 rounded px-2 py-0.5 transition-colors disabled:opacity-30"
            >
              add to playlist
            </button>
            {showSend && (
              <div className="absolute right-0 top-7 z-30 bg-chassis border border-border/40 rounded shadow-xl min-w-[200px] max-h-60 overflow-y-auto">
                {nonFolderPlaylists.length === 0 ? (
                  <p className="px-3 py-2 font-mono text-[12px] text-muted">no playlists</p>
                ) : nonFolderPlaylists.map((pl) => (
                  <button key={pl.id} onClick={() => sendToPlaylist(pl.id)} disabled={sending}
                    className="w-full text-left px-3 py-1.5 font-mono text-[12px] text-muted hover:text-ink hover:bg-ink/[0.05] transition-colors border-b border-border/20 last:border-b-0">
                    {pl.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Add to running order */}
          {runningOrders.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setShowOrderSend((v) => !v)}
                disabled={results.length === 0}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 hover:border-border/70 rounded px-2 py-0.5 transition-colors disabled:opacity-30"
              >
                add to order
              </button>
              {showOrderSend && (
                <div className="absolute right-0 top-7 z-30 bg-chassis border border-border/40 rounded shadow-xl min-w-[200px] max-h-48 overflow-y-auto">
                  {runningOrders.map((ro) => (
                    <button key={ro.id}
                      onClick={async () => {
                        setSending(true)
                        const trackIds = results.map((t) => t.id)
                        const existing = await window.api.library.getRunningOrders().then((ros) => ros.find((r) => r.id === ro.id))
                        if (existing) {
                          const existingSet = new Set(existing.entries.map((e) => e.trackId))
                          const newEntries = [
                            ...existing.entries,
                            ...trackIds.filter((id) => !existingSet.has(id)).map((id) => ({ id: crypto.randomUUID(), trackId: id, plannedTransition: null, note: null, flexible: false as const }))
                          ]
                          await window.api.library.updateRunningOrder(ro.id, { entries: newEntries })
                        }
                        setShowOrderSend(false); setSending(false)
                      }}
                      disabled={sending}
                      className="w-full text-left px-3 py-1.5 border-b border-border/20 last:border-b-0 transition-colors hover:bg-ink/[0.05]">
                      <p className="font-mono text-[11px] text-ink">N° {String(ro.catalogNum).padStart(3,'0')} · {ro.title || 'Untitled'}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Save as Smart Playlist */}
          <button
            onClick={saveAsSmartPlaylist}
            disabled={results.length === 0 || !isFiltered}
            className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent hover:text-ink border border-accent/30 hover:border-accent/60 rounded px-2 py-0.5 transition-colors disabled:opacity-30"
          >
            save as smart playlist
          </button>
        </div>

        {/* Column headers */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border/20 bg-chassis/50">
          <span className="w-1.5 shrink-0" />
          <span className="flex-1 font-mono text-[11px] uppercase tracking-[0.15em] text-muted/50">Title / Artist</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted/50 tabular-nums hidden md:block w-12 text-right">BPM</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted/50 hidden sm:block w-8 text-right">Key</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted/50 hidden lg:block w-10 text-right">Energy</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted/50 hidden lg:block w-10 text-right">Time</span>
          <span className="w-8 shrink-0" />
        </div>

        {/* Result list */}
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="font-mono text-[13px] text-muted/30 uppercase tracking-[0.15em]">
                {isFiltered ? 'no tracks match' : 'adjust filters to search'}
              </p>
            </div>
          ) : results.map((t) => (
            <ResultRow key={t.id} track={t} onLoadA={loadTrackA} onLoadB={loadTrackB}
              onContextMenu={(e, track) => openTrackMenu(e, { ids: [track.id], track })} />
          ))}
        </div>
      </div>
    </div>
  )
}
