/**
 * LibraryMini — a compact, windowed, sortable/searchable version of the main
 * library table, for docking into Lineage / Running Orders / Set Builder.
 *
 * Rows are draggable using the app's standard `application/x-offcut-track-ids`
 * payload (+ the libraryStore dragging flag), so every existing drop target
 * (decks, set chapters, running orders, the Lineage stage) accepts them.
 * Uses the same manual windowing as the main Library so big libraries stay fast.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useTrackPreview } from '../store/trackPreviewStore'
import { setTrackDragData } from '../lib/trackDrag'
import { formatHoursMinutes } from '../lib/format'
import { useVirtualList } from '../hooks/useVirtualList'
import { useTrackMenuContext } from '../hooks/useTrackMenu'
import type { Track } from '@shared/types'

const ROW_H = 26
const HEAD_H = 26
const OVERSCAN = 6

type SortKey = 'title' | 'artist' | 'genre' | 'bpm' | 'key'
const COLS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'bpm', label: 'BPM', num: true },
  { key: 'key', label: 'Key' }
]
const GRID = 'minmax(0,1fr) 84px 62px 42px 34px'

export function LibraryMini({
  onActivate,
  enablePlaylistScope = false
}: {
  onActivate?: (t: Track) => void
  /** Show a playlist picker that scopes the list to one playlist (Lineage tray). */
  enablePlaylistScope?: boolean
}): JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const setDragging = useLibraryStore((s) => s.setDragging)
  const clearDragging = useLibraryStore((s) => s.clearDragging)
  const previewId = useTrackPreview((s) => s.previewId)
  const togglePreview = useTrackPreview((s) => s.toggle)

  const [q, setQ] = useState('')
  // A null sortKey means "natural order" — the playlist's own curated order when a
  // scope is set, import order otherwise. Clicking a column switches to an explicit sort.
  const [sortKey, setSortKey] = useState<SortKey | null>('title')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const openTrackMenu = useTrackMenuContext()

  // Playlists you can scope to. Folders hold their tracks in child chapters, not
  // directly, so they're excluded; smart/auto-group playlists arrive pre-resolved.
  const scopablePlaylists = useMemo(
    () => (enablePlaylistScope ? playlists.filter((p) => !p.isFolder) : []),
    [enablePlaylistScope, playlists]
  )
  const scopePlaylist = scopeId ? playlists.find((p) => p.id === scopeId) ?? null : null

  const byId = useMemo(() => {
    const m = new Map<string, Track>()
    for (const t of tracks) m.set(t.id, t)
    return m
  }, [tracks])

  const rows = useMemo(() => {
    // A playlist scope keeps the playlist's curated order; tracks no longer in the
    // library are skipped.
    const base: Track[] = scopePlaylist
      ? scopePlaylist.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
      : tracks.slice()
    const term = q.toLowerCase().trim()
    const list = term
      ? base.filter((t) =>
          `${t.artist} ${t.title} ${t.album ?? ''} ${t.genre ?? ''}`.toLowerCase().includes(term)
        )
      : base
    if (sortKey == null) return list // natural order (playlist order when scoped)
    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = list.slice()
    sorted.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return sorted
  }, [tracks, byId, scopePlaylist, q, sortKey, sortDir])

  const scopeTotalSecs = useMemo(
    () => (scopePlaylist ? rows.reduce((sum, t) => sum + (t.durationSeconds ?? 0), 0) : 0),
    [scopePlaylist, rows]
  )

  const onScopeChange = (id: string): void => {
    if (id) {
      setScopeId(id)
      setSortKey(null) // present the playlist in its own order
    } else {
      setScopeId(null)
      setSortKey('title')
      setSortDir('asc')
    }
    setSelected(new Set())
    setLastClicked(null)
  }

  const { containerRef, start, end, topPad, bottomPad, onScroll } = useVirtualList(rows.length, ROW_H, OVERSCAN)
  const visible = rows.slice(start, end)

  const toggleSort = (k: SortKey): void => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(k)
      setSortDir('asc')
    }
  }

  const onRowClick = (e: React.MouseEvent, t: Track, idx: number): void => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const n = new Set(prev)
        if (n.has(t.id)) n.delete(t.id)
        else n.add(t.id)
        return n
      })
      setLastClicked(t.id)
    } else if (e.shiftKey && lastClicked) {
      const from = rows.findIndex((r) => r.id === lastClicked)
      if (from >= 0) {
        const lo = Math.min(from, idx)
        const hi = Math.max(from, idx)
        setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.id)))
      }
    } else {
      setSelected(new Set([t.id]))
      setLastClicked(t.id)
    }
  }

  const onDragStart = (e: React.DragEvent, t: Track): void => {
    const ids = selected.has(t.id) ? [...selected] : [t.id]
    if (!selected.has(t.id)) {
      setSelected(new Set([t.id]))
      setLastClicked(t.id)
    }
    setTrackDragData(e, ids)
    setDragging(ids)
  }

  return (
    <div className="flex h-full min-h-0">
      {enablePlaylistScope && scopablePlaylists.length > 0 && (
        <div className="shrink-0 w-[156px] flex flex-col border-r border-border/30 bg-ink/[0.02]">
          <div className="shrink-0 px-2 py-1.5 border-b border-border/30 font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">
            Playlists
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ScopeRow
              label="All tracks"
              count={tracks.length}
              color={null}
              active={!scopeId}
              onClick={() => onScopeChange('')}
            />
            {scopablePlaylists.map((p) => (
              <ScopeRow
                key={p.id}
                label={p.name}
                count={p.trackIds.length}
                color={p.color}
                active={scopeId === p.id}
                onClick={() => onScopeChange(p.id)}
              />
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col flex-1 min-w-0">
        {/* search */}
        <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border/30">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={scopePlaylist ? `filter ${scopePlaylist.name}…` : 'filter library…'}
            spellCheck={false}
            className="flex-1 min-w-0 bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50"
          />
          <span className="font-mono text-[10px] text-muted/60 tabular-nums shrink-0">
            {rows.length}
            {scopePlaylist ? ` · ${formatHoursMinutes(scopeTotalSecs)}` : ''}
          </span>
        </div>
      {/* header */}
      <div
        className="shrink-0 grid items-center gap-1 border-b border-border/30 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted/70 select-none"
        style={{ gridTemplateColumns: GRID, height: HEAD_H }}
      >
        {COLS.map((c) => (
          <button
            key={c.key}
            onClick={() => toggleSort(c.key)}
            className={`hover:text-ink transition-colors truncate ${c.num ? 'text-right' : 'text-left'}`}
          >
            {c.label}
            {sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        ))}
      </div>
      {/* windowed body */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto"
      >
        <div style={{ height: topPad }} />
        {visible.map((t, i) => {
          const idx = start + i
          const sel = selected.has(t.id)
          return (
            <div
              key={t.id}
              draggable
              onDragStart={(e) => onDragStart(e, t)}
              onDragEnd={() => clearDragging()}
              onClick={(e) => onRowClick(e, t, idx)}
              onDoubleClick={() => (onActivate ? onActivate(t) : togglePreview(t))}
              onContextMenu={(e) => {
                const ids = selected.has(t.id) && selected.size > 0 ? [...selected] : [t.id]
                openTrackMenu(e, { ids, track: t })
              }}
              title={`${t.artist} — ${t.title}`}
              className={`grid items-center gap-1 px-2 cursor-grab active:cursor-grabbing border-b border-border/10 ${
                sel ? 'bg-accent/15' : 'hover:bg-ink/[0.04]'
              }`}
              style={{ gridTemplateColumns: GRID, height: ROW_H }}
            >
              <span className="flex items-center gap-1.5 min-w-0 text-[12px] text-ink">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePreview(t)
                  }}
                  title="Preview 30s"
                  className={`shrink-0 w-4 h-4 flex items-center justify-center rounded text-[8px] leading-none transition-colors ${
                    previewId === t.id ? 'text-accent' : 'text-muted/40 hover:text-accent'
                  }`}
                >
                  {previewId === t.id ? '■' : '▶'}
                </button>
                <span className="truncate">{t.title}</span>
              </span>
              <span className="truncate text-[11px] text-muted">{t.artist}</span>
              <span className="truncate text-[11px] text-muted/70">{t.genre || '—'}</span>
              <span className="text-right text-[11px] font-mono tabular-nums text-muted">
                {t.bpm ? Math.round(t.bpm) : '—'}
              </span>
              <span className="text-[11px] font-mono text-accent/80 truncate">{t.key || '—'}</span>
            </div>
          )
        })}
        <div style={{ height: bottomPad }} />
        {rows.length === 0 && (
          <div className="p-4 text-center font-mono text-[12px] text-muted/60">
            {tracks.length === 0
              ? 'Library is empty — import tracks first.'
              : scopePlaylist && !q.trim()
                ? 'This playlist has no tracks.'
                : 'No matches.'}
          </div>
        )}
        </div>
        <PreviewBar />
      </div>
    </div>
  )
}

// ── Playlist scope rail row ───────────────────────────────────────────────────
function ScopeRow({
  label,
  count,
  color,
  active,
  onClick
}: {
  label: string
  count: number
  color: string | null
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={`${label} · ${count} track${count === 1 ? '' : 's'}`}
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-left border-b border-border/10 transition-colors ${
        active ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-ink/[0.04] hover:text-ink-soft'
      }`}
    >
      <span
        className="shrink-0 w-1.5 h-1.5 rounded-full"
        style={color ? { background: color } : { border: '1px solid rgba(150,140,119,0.4)' }}
      />
      <span className="flex-1 min-w-0 truncate text-[11px]">{label}</span>
      <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted/50">{count}</span>
    </button>
  )
}

// ── Waveform preview bar — shown while a row is previewing ────────────────────
function PreviewBar(): JSX.Element | null {
  const previewId = useTrackPreview((s) => s.previewId)
  const peaks = useTrackPreview((s) => s.peaks)
  const progress = useTrackPreview((s) => s.progress)
  const stop = useTrackPreview((s) => s.stop)
  const track = useLibraryStore((s) => (previewId ? s.tracks.find((t) => t.id === previewId) : null))
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.offsetWidth
    const h = cv.offsetHeight
    if (!w || !h) return
    cv.width = w * dpr
    cv.height = h * dpr
    const g = cv.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, cv.width, cv.height)
    if (!peaks || !peaks.length) return
    const muted = getComputedStyle(cv).color || 'rgba(150,140,119,0.6)'
    const accent = '#D86A4A'
    const n = peaks.length
    const bw = cv.width / n
    const mid = cv.height / 2
    const playedX = progress * cv.width
    for (let i = 0; i < n; i++) {
      const x = i * bw
      const bh = Math.max(dpr, peaks[i] * cv.height * 0.92)
      g.fillStyle = x <= playedX ? accent : muted
      g.fillRect(x, mid - bh / 2, Math.max(dpr, bw * 0.7), bh)
    }
    g.fillStyle = accent
    g.fillRect(playedX, 0, dpr, cv.height)
  }, [peaks, progress])

  if (!previewId) return null
  return (
    <div className="shrink-0 border-t border-border/30 px-2 py-1.5 flex items-center gap-2 bg-ink/[0.03]">
      <button
        onClick={stop}
        title="Stop preview"
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-[10px] text-accent border border-accent/40 hover:bg-accent/10 transition-colors"
      >
        ■
      </button>
      <div className="flex-1 min-w-0">
        <canvas ref={canvasRef} className="w-full block text-muted/50" style={{ height: 26 }} />
      </div>
      <div className="shrink-0 max-w-[40%] min-w-0 text-right">
        <div className="truncate font-mono text-[10px] text-ink">{track?.title ?? ''}</div>
        <div className="truncate font-mono text-[9px] text-muted/60">{track?.artist ?? ''}</div>
      </div>
    </div>
  )
}
