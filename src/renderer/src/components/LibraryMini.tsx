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

export function LibraryMini({ onActivate }: { onActivate?: (t: Track) => void }): JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const setDragging = useLibraryStore((s) => s.setDragging)
  const clearDragging = useLibraryStore((s) => s.clearDragging)
  const previewId = useTrackPreview((s) => s.previewId)
  const togglePreview = useTrackPreview((s) => s.toggle)

  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('title')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const openTrackMenu = useTrackMenuContext()

  const rows = useMemo(() => {
    const term = q.toLowerCase().trim()
    const list = term
      ? tracks.filter((t) =>
          `${t.artist} ${t.title} ${t.album ?? ''} ${t.genre ?? ''}`.toLowerCase().includes(term)
        )
      : tracks.slice()
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return list
  }, [tracks, q, sortKey, sortDir])

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
    <div className="flex flex-col h-full min-h-0">
      {/* search */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border/30">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter library…"
          spellCheck={false}
          className="flex-1 min-w-0 bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50"
        />
        <span className="font-mono text-[10px] text-muted/60 tabular-nums shrink-0">{rows.length}</span>
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
            {tracks.length === 0 ? 'Library is empty — import tracks first.' : 'No matches.'}
          </div>
        )}
      </div>
      <PreviewBar />
    </div>
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
