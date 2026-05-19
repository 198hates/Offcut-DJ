import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { FilterBar } from '../../components/FilterBar'
import { BulkEditBar } from '../../components/BulkEditBar'
import type { Track } from '@shared/types'

const ROW_HEIGHT = 36   // px — must match the <tr> height
const HEADER_HEIGHT = 37 // px — sticky thead height
const OVERSCAN = 8      // rows rendered above/below the viewport

const COLUMNS: { key: keyof Track; label: string; width: string }[] = [
  { key: 'title',           label: 'Title',  width: '28%' },
  { key: 'artist',          label: 'Artist', width: '18%' },
  { key: 'album',           label: 'Album',  width: '16%' },
  { key: 'genre',           label: 'Genre',  width: '10%' },
  { key: 'bpm',             label: 'BPM',    width: '7%'  },
  { key: 'key',             label: 'Key',    width: '6%'  },
  { key: 'rating',          label: '★',      width: '7%'  },
  { key: 'durationSeconds', label: 'Time',   width: '8%'  }
]

type SortKey = keyof Track
type SortDir = 'asc' | 'desc'

export function LibraryPage(): JSX.Element {
  const { isLoading, selectedTrackIds, setSelectedTrackIds, setDragging, clearDragging } = useLibraryStore()
  const filteredTracks = useLibraryStore((s) => s.filteredTracks())

  const [sortKey, setSortKey] = useState<SortKey>('artist')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

  // ── Virtual scroll state ──────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop]       = useState(0)
  const [containerHeight, setContainerHeight] = useState(600)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight))
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    setContainerHeight(el.clientHeight)
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect() }
  }, [])

  // ── Sort ──────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    return [...filteredTracks].sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredTracks, sortKey, sortDir])

  const handleSort = useCallback((key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }, [sortKey])

  // ── Virtual window ────────────────────────────────────────────────────────
  const start  = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end    = Math.min(sorted.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN)
  const visible   = sorted.slice(start, end)
  const topPad    = start * ROW_HEIGHT
  const bottomPad = Math.max(0, (sorted.length - end) * ROW_HEIGHT)

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't steal keys while typing in FilterBar / search
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    // Cmd/Ctrl+A — select all visible
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      setSelectedTrackIds(new Set(sorted.map((t) => t.id)))
      return
    }

    // Escape — clear selection
    if (e.key === 'Escape') {
      e.preventDefault()
      setSelectedTrackIds(new Set())
      setLastClickedId(null)
      return
    }

    // Arrow Up / Down — navigate rows
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const current = lastClickedId ? sorted.findIndex((t) => t.id === lastClickedId) : -1
      const next =
        e.key === 'ArrowDown'
          ? Math.min(sorted.length - 1, current + 1)
          : Math.max(0, current <= 0 ? 0 : current - 1)
      if (next < 0 || next >= sorted.length) return
      const nextId = sorted[next].id

      if (e.shiftKey && lastClickedId && current >= 0) {
        // Extend selection from anchor to cursor
        const lo = Math.min(current, next)
        const hi = Math.max(current, next)
        setSelectedTrackIds(new Set(sorted.slice(lo, hi + 1).map((t) => t.id)))
      } else {
        setSelectedTrackIds(new Set([nextId]))
        setLastClickedId(nextId)
      }

      // Scroll row into view (account for sticky header)
      const el = containerRef.current
      if (el) {
        const rowY = next * ROW_HEIGHT
        if (rowY < el.scrollTop + HEADER_HEIGHT) {
          el.scrollTop = rowY
        } else if (rowY + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
          el.scrollTop = rowY + ROW_HEIGHT - el.clientHeight
        }
      }
    }
  }, [sorted, lastClickedId, setSelectedTrackIds])

  // ── Row click (shift / meta / plain) ─────────────────────────────────────
  const handleRowClick = useCallback((e: React.MouseEvent, id: string) => {
    containerRef.current?.focus()
    if (e.shiftKey && lastClickedId) {
      const ids  = sorted.map((t) => t.id)
      const from = ids.indexOf(lastClickedId)
      const to   = ids.indexOf(id)
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
      setSelectedTrackIds(new Set(e.metaKey || e.ctrlKey ? [...selectedTrackIds, ...range] : range))
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedTrackIds)
      next.has(id) ? next.delete(id) : next.add(id)
      setSelectedTrackIds(next)
      setLastClickedId(id)
    } else {
      setSelectedTrackIds(new Set([id]))
      setLastClickedId(id)
    }
  }, [selectedTrackIds, lastClickedId, sorted, setSelectedTrackIds])

  // ── Drag handlers ─────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, track: Track) => {
    const ids = selectedTrackIds.has(track.id) ? [...selectedTrackIds] : [track.id]
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('application/x-crate-track-ids', JSON.stringify(ids))
    setDragging(ids)
  }, [selectedTrackIds, setDragging])

  const handleDragEnd = useCallback(() => clearDragging(), [clearDragging])

  const clearSelection = useCallback(() => {
    setSelectedTrackIds(new Set())
    setLastClickedId(null)
  }, [setSelectedTrackIds])

  const selectedArr = [...selectedTrackIds]
  const showBulkBar = selectedArr.length >= 2

  return (
    <div
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <FilterBar />

      {showBulkBar && (
        <BulkEditBar selectedIds={selectedArr} onClearSelection={clearSelection} />
      )}

      {!showBulkBar && (
        <div className="flex items-center gap-2 px-4 py-1 border-b border-white/5 shrink-0">
          <span className="text-white/30 text-xs ml-auto">
            {sorted.length.toLocaleString()} tracks
            {selectedTrackIds.size === 1 && ' · 1 selected'}
          </span>
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-auto outline-none">
        <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 32 }} />
            {COLUMNS.map((col) => <col key={col.key} style={{ width: col.width }} />)}
          </colgroup>

          <thead className="sticky top-0 z-10 bg-surface-900">
            <tr style={{ height: HEADER_HEIGHT }}>
              <th className="w-8 px-2 py-2 border-b border-white/5">
                <input
                  type="checkbox"
                  checked={sorted.length > 0 && sorted.every((t) => selectedTrackIds.has(t.id))}
                  onChange={(e) =>
                    setSelectedTrackIds(e.target.checked ? new Set(sorted.map((t) => t.id)) : new Set())
                  }
                  className="accent-accent"
                />
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white/40 cursor-pointer hover:text-white/70 transition-colors select-none border-b border-white/5 truncate"
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1 opacity-60">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center py-16 text-white/30 text-sm">
                  Loading library…
                </td>
              </tr>
            )}
            {!isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="text-center py-16 text-white/30 text-sm">
                  <div className="space-y-2">
                    <p>No tracks found.</p>
                    <p className="text-xs opacity-60">Try adjusting your search or filters, or import a library using the sidebar.</p>
                  </div>
                </td>
              </tr>
            )}

            {/* Virtual top spacer */}
            {topPad > 0 && (
              <tr aria-hidden="true"><td colSpan={COLUMNS.length + 1} style={{ height: topPad, padding: 0 }} /></tr>
            )}

            {visible.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                isSelected={selectedTrackIds.has(track.id)}
                onClick={handleRowClick}
                onCheckbox={(checked) => {
                  const next = new Set(selectedTrackIds)
                  checked ? next.add(track.id) : next.delete(track.id)
                  setSelectedTrackIds(next)
                }}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
            ))}

            {/* Virtual bottom spacer */}
            {bottomPad > 0 && (
              <tr aria-hidden="true"><td colSpan={COLUMNS.length + 1} style={{ height: bottomPad, padding: 0 }} /></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface TrackRowProps {
  track: Track
  isSelected: boolean
  onClick: (e: React.MouseEvent, id: string) => void
  onCheckbox: (checked: boolean) => void
  onDragStart: (e: React.DragEvent, track: Track) => void
  onDragEnd: () => void
}

function TrackRow({ track, isSelected, onClick, onCheckbox, onDragStart, onDragEnd }: TrackRowProps): JSX.Element {
  return (
    <tr
      draggable
      onClick={(e) => onClick(e, track.id)}
      onDragStart={(e) => onDragStart(e, track)}
      onDragEnd={onDragEnd}
      style={{ height: ROW_HEIGHT }}
      className={`cursor-pointer transition-colors border-b border-white/[0.03] group select-none ${
        isSelected ? 'bg-accent/20' : 'hover:bg-white/[0.04]'
      }`}
    >
      <td className="w-8 px-2" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onCheckbox(e.target.checked)}
          className="accent-accent"
        />
      </td>
      <td className="px-3 max-w-0 overflow-hidden">
        <span className={`truncate block text-sm ${!track.title ? 'text-white/30 italic' : ''}`}>
          {track.title || 'Unknown Title'}
        </span>
      </td>
      <td className="px-3 text-white/80 text-sm max-w-0 overflow-hidden">
        <span className="truncate block">{track.artist || '—'}</span>
      </td>
      <td className="px-3 text-white/60 text-sm max-w-0 overflow-hidden">
        <span className="truncate block">{track.album || '—'}</span>
      </td>
      <td className="px-3 text-white/60 text-sm overflow-hidden">
        <span className="truncate block">{track.genre || '—'}</span>
      </td>
      <td className="px-3 text-white/60 text-sm tabular-nums">
        {track.bpm ? track.bpm.toFixed(1) : '—'}
      </td>
      <td className="px-3 text-white/60 font-mono text-xs">
        {track.key || '—'}
      </td>
      <td className="px-3">
        <StarRating rating={track.rating} />
      </td>
      <td className="px-3 text-white/40 text-xs tabular-nums">
        {formatDuration(track.durationSeconds)}
      </td>
    </tr>
  )
}

function StarRating({ rating }: { rating: number }): JSX.Element {
  return (
    <span className="text-xs">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-yellow-400' : 'text-white/15'}>★</span>
      ))}
    </span>
  )
}

function formatDuration(secs: number | null): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
