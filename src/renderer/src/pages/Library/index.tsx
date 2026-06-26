import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore, useDeckBStore } from '../../store/playerStore'
import { useAutomixStore } from '../../store/automixStore'
import type { TransitionStyleChoice } from '../../lib/automixPlan'

/** Auto-mix transition styles offered in the Library toolbar. */
const AUTOMIX_STYLES: { id: TransitionStyleChoice; label: string }[] = [
  { id: 'auto',       label: 'Auto' },
  { id: 'fade',       label: 'Fade' },
  { id: 'eqBassSwap', label: 'Bass swap' },
  { id: 'echoOut',    label: 'Echo out' },
  { id: 'filter',     label: 'Filter' },
  { id: 'cut',        label: 'Cut' }
]
import { FilterBar } from '../../components/FilterBar'
import { BulkEditBar } from '../../components/BulkEditBar'
import { SetTimeline } from '../../components/SetTimeline'
import { keyBlipColor } from '../../components/CamelotWheel'
import { compatibilityScore } from '../../lib/compatibility'
import { usePreview } from '../../hooks/usePreview'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import { useToastStore } from '../../store/toastStore'
import { useWaveformStore, displayKey } from '../../store/waveformStore'
import { setTrackDragData } from '../../lib/trackDrag'
import { formatDuration, formatBpm, formatFileSize, formatSampleRate } from '../../lib/format'
import { useVirtualList } from '../../hooks/useVirtualList'
import type { Track } from '@shared/types'

const ROW_HEIGHT    = 32
const HEADER_HEIGHT = 30
const OVERSCAN      = 8

interface ColumnDef {
  id: string
  sortKey: keyof Track
  label: string
  width: string
  defaultVisible: boolean
}

const COLUMN_DEFS: ColumnDef[] = [
  { id: 'title',           sortKey: 'title',           label: 'Title',    width: 'auto',  defaultVisible: true  },
  { id: 'artist',          sortKey: 'artist',          label: 'Artist',   width: '110px', defaultVisible: true  },
  { id: 'genre',           sortKey: 'genre',           label: 'Genre',    width: '80px',  defaultVisible: true  },
  { id: 'label',           sortKey: 'label',           label: 'Label',    width: '80px',  defaultVisible: true  },
  { id: 'year',            sortKey: 'year',            label: 'Year',     width: '50px',  defaultVisible: true  },
  { id: 'bpm',             sortKey: 'bpm',             label: 'BPM',      width: '52px',  defaultVisible: true  },
  { id: 'key',             sortKey: 'key',             label: 'Key',      width: '44px',  defaultVisible: true  },
  { id: 'energy',          sortKey: 'energy',          label: 'Nrg',      width: '56px',  defaultVisible: true  },
  { id: 'mood',            sortKey: 'mood',            label: 'Mood',     width: '52px',  defaultVisible: true  },
  { id: 'rating',          sortKey: 'rating',          label: '★',        width: '52px',  defaultVisible: true  },
  { id: 'durationSeconds', sortKey: 'durationSeconds', label: 'Time',     width: '54px',  defaultVisible: true  },
  { id: 'fileType',        sortKey: 'fileType',        label: 'Fmt',      width: '38px',  defaultVisible: false },
  { id: 'fileSize',        sortKey: 'fileSize',        label: 'Size',     width: '52px',  defaultVisible: false },
  { id: 'bitDepth',        sortKey: 'bitDepth',        label: 'Bits',     width: '42px',  defaultVisible: false },
  { id: 'sampleRate',      sortKey: 'sampleRate',      label: 'Hz',       width: '52px',  defaultVisible: false },
  { id: 'updatedAt',       sortKey: 'updatedAt',       label: 'Modified', width: '72px',  defaultVisible: false },
]

type SortKey = keyof Track
type SortDir = 'asc' | 'desc'
interface SortLevel { key: SortKey; dir: SortDir }

// ── helpers ───────────────────────────────────────────────────────────────────
function formatModified(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  } catch { return '—' }
}

export function LibraryPage(): JSX.Element {
  const { isLoading, selectedTrackIds, setSelectedTrackIds, setDragging, clearDragging, activePlaylistId, playlists, addTracksToPlaylist } = useLibraryStore()
  const showToast = useToastStore((s) => s.show)
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const loadTrackB = useDeckBStore((s) => s.loadTrack)
  const { toggle: previewToggle } = usePreview()
  const filteredTracks = useLibraryStore((s) => s.filteredTracks())
  const allTracks = useLibraryStore((s) => s.tracks)
  const automix = useAutomixStore()
  const [amStyle, setAmStyle] = useState<TransitionStyleChoice>('auto')

  const openTrackMenu = useTrackMenuContext()
  const [showSuggest, setShowSuggest] = useState(false)
  const [showColPicker, setShowColPicker] = useState(false)

  const [sortSpec, setSortSpec] = useState<SortLevel[]>([{ key: 'artist', dir: 'asc' }])
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

  // Column visibility — persisted to localStorage
  const [visibleColIds, setVisibleColIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('offcut-col-visibility')
      if (stored) return new Set(JSON.parse(stored) as string[])
    } catch { /* ignore */ }
    return new Set(COLUMN_DEFS.filter((c) => c.defaultVisible).map((c) => c.id))
  })
  const toggleCol = useCallback((id: string) => {
    setVisibleColIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      try { localStorage.setItem('offcut-col-visibility', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])

  const visibleCols = COLUMN_DEFS.filter((c) => visibleColIds.has(c.id))

  const containerRef = useRef<HTMLDivElement>(null)

  // Focus the outer container on mount so arrow keys work immediately
  useEffect(() => {
    const outer = containerRef.current?.closest<HTMLElement>('[tabindex]')
    outer?.focus({ preventScroll: true })
  }, [])

  const sorted = useMemo(() => {
    return [...filteredTracks].sort((a, b) => {
      for (const { key, dir } of sortSpec) {
        const av = a[key] ?? ''
        const bv = b[key] ?? ''
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
      }
      return 0
    })
  }, [filteredTracks, sortSpec])

  const handleSort = useCallback((key: SortKey, e: React.MouseEvent) => {
    if (e.shiftKey) {
      // Add / toggle secondary sort level
      setSortSpec((prev) => {
        const idx = prev.findIndex((s) => s.key === key)
        if (idx === 0) {
          // Toggle primary direction
          return [{ key, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }, ...prev.slice(1)]
        }
        if (idx > 0) {
          // Toggle existing secondary
          const updated = [...prev]
          updated[idx] = { key, dir: updated[idx].dir === 'asc' ? 'desc' : 'asc' }
          return updated
        }
        // Append as secondary (cap at 3 levels)
        return [...prev.slice(0, 2), { key, dir: 'asc' }]
      })
    } else {
      // Primary sort
      setSortSpec((prev) => {
        const existing = prev.find((s) => s.key === key)
        if (existing && prev[0].key === key) {
          return [{ key, dir: existing.dir === 'asc' ? 'desc' : 'asc' }]
        }
        return [{ key, dir: 'asc' }]
      })
    }
  }, [])

  const { start, end, topPad, bottomPad, onScroll } = useVirtualList(
    sorted.length,
    ROW_HEIGHT,
    OVERSCAN,
    containerRef
  )
  const visible = sorted.slice(start, end)

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      setSelectedTrackIds(new Set(sorted.map((t) => t.id)))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSelectedTrackIds(new Set())
      setLastClickedId(null)
      return
    }
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
        const lo = Math.min(current, next), hi = Math.max(current, next)
        setSelectedTrackIds(new Set(sorted.slice(lo, hi + 1).map((t) => t.id)))
      } else {
        setSelectedTrackIds(new Set([nextId]))
        setLastClickedId(nextId)
      }
      const el = containerRef.current
      if (el) {
        const rowY = next * ROW_HEIGHT
        if (rowY < el.scrollTop + HEADER_HEIGHT) el.scrollTop = rowY
        else if (rowY + ROW_HEIGHT > el.scrollTop + el.clientHeight)
          el.scrollTop = rowY + ROW_HEIGHT - el.clientHeight
      }
      return
    }
    // Enter — load to deck
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = lastClickedId ? sorted.find((t) => t.id === lastClickedId) : null
      if (!target) return
      if (e.shiftKey) loadTrackB(target)
      else            loadTrackA(target)
      return
    }
    // Space — toggle 30s preview on selected track
    if (e.key === ' ') {
      e.preventDefault()
      const target = lastClickedId ? sorted.find((t) => t.id === lastClickedId) : null
      if (target) previewToggle(target)
      return
    }
    // Delete / Backspace — remove from active playlist (or nothing if all-tracks view)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const ids = [...selectedTrackIds]
      if (!ids.length) return
      if (activePlaylistId) {
        // Remove from playlist, don't delete the tracks themselves
        useLibraryStore.getState().removeTracksFromPlaylist(activePlaylistId, ids)
      }
      return
    }
  }, [sorted, lastClickedId, selectedTrackIds, activePlaylistId, loadTrackA, loadTrackB, previewToggle, setSelectedTrackIds, setLastClickedId])

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

  const handleDragStart = useCallback((e: React.DragEvent, track: Track) => {
    const ids = selectedTrackIds.has(track.id) ? [...selectedTrackIds] : [track.id]
    setTrackDragData(e, ids)
    setDragging(ids)
  }, [selectedTrackIds, setDragging])

  const handleDragEnd = useCallback(() => clearDragging(), [clearDragging])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track) => {
    // If the right-clicked track isn't in the current selection, select only it
    let ids: string[]
    if (selectedTrackIds.has(track.id)) {
      ids = [...selectedTrackIds]
    } else {
      setSelectedTrackIds(new Set([track.id]))
      setLastClickedId(track.id)
      ids = [track.id]
    }
    openTrackMenu(e, { ids, track, playlistId: activePlaylistId })
  }, [selectedTrackIds, setSelectedTrackIds, openTrackMenu, activePlaylistId])

  const clearSelection = useCallback(() => {
    setSelectedTrackIds(new Set())
    setLastClickedId(null)
  }, [setSelectedTrackIds])

  // Track analysis (BPM/key, energy, beat grid, auto-cue) now lives in the
  // shared analysisStore so every page's right-click menu can run it; the
  // progress bar is rendered globally in App.

  const selectedArr = [...selectedTrackIds]
  const showBulkBar = selectedArr.length >= 2

  // Set timeline: ordered tracks of the active playlist
  const activePlaylist = activePlaylistId ? playlists.find((p) => p.id === activePlaylistId) : null
  const timelineTracks = useMemo(() => {
    if (!activePlaylist) return []
    return activePlaylist.trackIds
      .map((id) => allTracks.find((t) => t.id === id))
      .filter((t): t is Track => !!t)
  }, [activePlaylist, allTracks])

  return (
    <div
      className="flex flex-col h-full outline-none focus-visible:ring-1 focus-visible:ring-accent/20 focus-visible:ring-inset"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <FilterBar />

      {showBulkBar && (
        <BulkEditBar selectedIds={selectedArr} onClearSelection={clearSelection} />
      )}

      {!showBulkBar && (
        <div className="relative flex items-center gap-1.5 px-3 py-1.5 border-b border-border/20 shrink-0">
          <span className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted">
            {activePlaylist ? activePlaylist.name : 'all tracks'}
          </span>
          <span className="font-mono text-[12px] text-muted ml-auto tabular-nums">
            {sorted.length.toLocaleString()} trks
            {selectedTrackIds.size === 1 && ' · 1 selected'}
          </span>

          {/* Auto-mix — play and let it pick compatible tracks from this view */}
          {sorted.length >= 2 && (
            automix.active ? (
              <button
                onClick={() => automix.stop()}
                title={automix.nextTitle ? `Auto-mixing · next: ${automix.nextTitle}` : 'Stop auto-mix'}
                className="ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[12px] bg-accent/10 text-accent transition-colors"
              >
                ■ auto{automix.phase === 'transition' ? ' ⇢' : ''}{automix.nextTitle ? ` · ${automix.nextTitle.slice(0, 14)}` : ''}
              </button>
            ) : (
              <span className="ml-1 flex items-center gap-1">
                <select
                  value={amStyle}
                  onChange={(e) => setAmStyle(e.target.value as TransitionStyleChoice)}
                  title="Transition style"
                  className="bg-paper border border-border/40 rounded font-mono text-[11px] text-ink px-1 py-0.5 outline-none focus:border-accent/60"
                >
                  {AUTOMIX_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <button
                  onClick={() => {
                    const seed = (selectedTrackIds.size ? sorted.find((t) => selectedTrackIds.has(t.id)) : null) ?? sorted[0]
                    if (seed) automix.start([seed], 0, 16, { autoSelect: true, pool: sorted, style: amStyle })
                  }}
                  title="Auto-mix — start from the selected (or first) track and auto-pick compatible tracks from this view"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[12px] text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                >
                  ▶ auto-mix
                </button>
              </span>
            )
          )}
          {activePlaylist && sorted.length >= 1 && (
            <button
              onClick={() => setShowSuggest((v) => !v)}
              title="Find matching tracks — suggest library tracks that fit this playlist"
              className={`ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[12px] transition-colors ${showSuggest ? 'bg-accent/10 text-accent' : 'text-muted hover:text-accent hover:bg-accent/10'}`}
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="4" cy="4" r="2.5"/>
                <path d="M6 6l2 2"/>
                <path d="M4 1.5V0M4 8v-1.5M1.5 4H0M8 4H6.5"/>
              </svg>
              suggest
            </button>
          )}
          {/* Column picker toggle */}
          <button
            onClick={() => setShowColPicker((v) => !v)}
            title="Show / hide columns"
            className={`ml-1 px-1.5 py-0.5 rounded font-mono text-[12px] transition-colors ${showColPicker ? 'bg-accent/10 text-accent' : 'text-muted hover:text-accent hover:bg-accent/10'}`}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="5" cy="5" r="1.5"/>
              <circle cx="5" cy="5" r="4" strokeDasharray="2 2"/>
            </svg>
          </button>

          {/* Column picker dropdown */}
          {showColPicker && (
            <div
              className="absolute right-0 top-full z-30 mt-1 rounded border border-border/40 bg-chassis-soft shadow-lg p-2 min-w-[140px]"
              onMouseLeave={() => setShowColPicker(false)}
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted mb-1.5 px-1">columns</p>
              {COLUMN_DEFS.map((col) => (
                <label key={col.id} className="flex items-center gap-1.5 px-1 py-0.5 rounded cursor-pointer hover:bg-ink/[0.06] transition-colors">
                  <input
                    type="checkbox"
                    checked={visibleColIds.has(col.id)}
                    onChange={() => toggleCol(col.id)}
                    className="accent-accent"
                  />
                  <span className="font-mono text-[12px] text-ink-soft">{col.label}</span>
                  {!col.defaultVisible && (
                    <span className="ml-auto font-mono text-[10px] text-muted/50 uppercase">+</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      )}


      <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-auto outline-none">
        <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 28 }} />   {/* checkbox */}
            <col style={{ width: 14 }} />   {/* blip */}
            <col style={{ width: 16 }} />   {/* status */}
            {visibleCols.map((col) => <col key={col.id} style={{ width: col.width }} />)}
          </colgroup>

          <thead className="sticky top-0 z-10 bg-chassis-soft">
            <tr style={{ height: HEADER_HEIGHT }}>
              <th className="w-7 px-2 border-b border-border/30">
                <input
                  type="checkbox"
                  checked={sorted.length > 0 && sorted.every((t) => selectedTrackIds.has(t.id))}
                  onChange={(e) => setSelectedTrackIds(e.target.checked ? new Set(sorted.map((t) => t.id)) : new Set())}
                  className="accent-accent"
                />
              </th>
              <th className="border-b border-border/30" />
              <th className="border-b border-border/30" />
              {visibleCols.map((col) => {
                const sortIdx = sortSpec.findIndex((s) => s.key === col.sortKey)
                const sortLevel = sortIdx >= 0 ? sortSpec[sortIdx] : null
                return (
                  <th
                    key={col.id}
                    onClick={(e) => handleSort(col.sortKey, e)}
                    title={sortSpec.length > 1 ? 'Click: primary sort · Shift+click: add/toggle secondary sort' : 'Click to sort · Shift+click to add secondary sort'}
                    className="text-left px-2 text-[12px] font-mono font-bold uppercase tracking-[0.06em] text-muted cursor-pointer hover:text-ink transition-colors select-none border-b border-border/30 truncate"
                  >
                    {col.label}
                    {sortLevel && (
                      <span className="ml-0.5 text-accent text-[11px]">
                        {sortSpec.length > 1 && sortIdx > 0 && <span style={{ opacity: 0.6 }}>{sortIdx + 1}</span>}
                        {sortLevel.dir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {isLoading && (
              <tr><td colSpan={visibleCols.length + 3} className="text-center py-16 text-muted text-xs font-mono">loading library…</td></tr>
            )}
            {!isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length + 3} className="text-center py-16">
                  <div className="space-y-2">
                    <p className="text-muted text-xs font-mono">no tracks found</p>
                    <p className="text-[13px] font-mono text-muted/60">try adjusting your search or import a library from the sidebar</p>
                  </div>
                </td>
              </tr>
            )}

            {topPad > 0 && (
              <tr aria-hidden="true"><td colSpan={visibleCols.length + 3} style={{ height: topPad, padding: 0 }} /></tr>
            )}

            {visible.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                isSelected={selectedTrackIds.has(track.id)}
                visibleColIds={visibleColIds}
                onClick={handleRowClick}
                onDoubleClick={(t, e) => e.shiftKey ? loadTrackB(t) : loadTrackA(t)}
                onContextMenu={handleContextMenu}
                onCheckbox={(checked) => {
                  const next = new Set(selectedTrackIds)
                  checked ? next.add(track.id) : next.delete(track.id)
                  setSelectedTrackIds(next)
                }}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
            ))}

            {bottomPad > 0 && (
              <tr aria-hidden="true"><td colSpan={visibleCols.length + 3} style={{ height: bottomPad, padding: 0 }} /></tr>
            )}
          </tbody>
        </table>
      </div>

      {timelineTracks.length >= 2 && (
        <SetTimeline tracks={timelineTracks} />
      )}

      {showSuggest && activePlaylist && (
        <SuggestionsPanel
          playlistTracks={timelineTracks}
          allTracks={allTracks}
          playlistId={activePlaylist.id}
          onClose={() => setShowSuggest(false)}
          onAdd={(ids) => addTracksToPlaylist(activePlaylist.id, ids).then(() =>
            showToast(`Added ${ids.length} track${ids.length !== 1 ? 's' : ''} to ${activePlaylist.name}`, 'success')
          )}
          onLoadA={loadTrackA}
        />
      )}

    </div>
  )
}

// ── TrackRow ──────────────────────────────────────────────────────────────────

interface TrackRowProps {
  track: Track
  isSelected: boolean
  visibleColIds: Set<string>
  onClick: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (track: Track, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, track: Track) => void
  onCheckbox: (checked: boolean) => void
  onDragStart: (e: React.DragEvent, track: Track) => void
  onDragEnd: () => void
}

function TrackRow({ track, isSelected, visibleColIds, onClick, onDoubleClick, onContextMenu, onCheckbox, onDragStart, onDragEnd }: TrackRowProps): JSX.Element {
  const blipColor   = keyBlipColor(track.key)
  const keyNotation = useWaveformStore((s) => s.keyNotation)
  const show = (id: string): boolean => visibleColIds.has(id)

  return (
    <tr
      draggable
      onClick={(e) => onClick(e, track.id)}
      onDoubleClick={(e) => onDoubleClick(track, e)}
      onContextMenu={(e) => onContextMenu(e, track)}
      onDragStart={(e) => onDragStart(e, track)}
      onDragEnd={onDragEnd}
      style={{
        height: ROW_HEIGHT,
        boxShadow: track.color ? `inset 3px 0 0 ${track.color}` : undefined
      }}
      className={`cursor-pointer border-b border-border/20 select-none group transition-colors ${
        isSelected ? 'bg-accent/[0.07]' : 'hover:bg-ink/[0.04]'
      }`}
    >
      <td className="w-7 px-2" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={isSelected} onChange={(e) => onCheckbox(e.target.checked)} className="accent-accent" />
      </td>

      {/* Blip */}
      <td className="w-3.5">
        <span className="block w-1.5 h-1.5 rounded-sm mx-auto" style={{ background: blipColor }} />
      </td>

      {/* Analysis status icons + freshness */}
      <td className="w-4">
        <div className="flex flex-col items-center gap-px">
          {/* Freshness dot */}
          {(() => {
            // "New to library" — added within 7 days
            const addedDays = track.dateAdded
              ? (Date.now() - new Date(track.dateAdded).getTime()) / 86400000
              : Infinity
            if (addedDays < 7) return (
              <span title="Added within the last 7 days" style={{ lineHeight: 0 }}>
                <svg width="5" height="5" viewBox="0 0 5 5"><circle cx="2.5" cy="2.5" r="2.5" fill="rgba(78,112,144,0.80)"/></svg>
              </span>
            )
            return null
          })()}
          {track.playCount > 0 && track.lastPlayedAt && (() => {
            const days = (Date.now() - new Date(track.lastPlayedAt).getTime()) / 86400000
            if (days > 180) return (
              <span title={`Not played in ${Math.floor(days / 30)} months — rediscovery candidate`} style={{ lineHeight: 0 }}>
                <svg width="5" height="5" viewBox="0 0 5 5"><circle cx="2.5" cy="2.5" r="2.5" fill="rgba(201,160,44,0.70)"/></svg>
              </span>
            )
            if (days < 7) return (
              <span title="Played this week" style={{ lineHeight: 0 }}>
                <svg width="5" height="5" viewBox="0 0 5 5"><circle cx="2.5" cy="2.5" r="2.5" fill="rgba(74,155,111,0.70)"/></svg>
              </span>
            )
            return null
          })()}
          {track.bpm != null ? (
            <span title="BPM analysed" style={{ lineHeight: 0 }}>
              <svg width="9" height="7" viewBox="0 0 9 7" fill="currentColor"
                style={{ color: 'rgb(var(--accent-rgb) / 0.65)' }}>
                <rect x="0"   y="3"   width="2" height="4" rx="0.4"/>
                <rect x="3.5" y="0"   width="2" height="7" rx="0.4"/>
                <rect x="7"   y="1.5" width="2" height="5.5" rx="0.4"/>
              </svg>
            </span>
          ) : (
            <span title="No BPM or key — run analysis" style={{ lineHeight: 0 }}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"
                style={{ color: 'rgba(180,160,140,0.22)' }}>
                <circle cx="4" cy="4" r="3" strokeDasharray="1.5 2.5"/>
              </svg>
            </span>
          )}
          {track.beatgrid.length > 0 && (() => {
            const bg = track.analysedBeatgrid
            const isKept = bg?.source === 'manual'
            const meanConf = bg && bg.beats.length > 0
              ? bg.beats.reduce((s, b) => s + b.confidence, 0) / bg.beats.length
              : null
            const needsEye = !isKept && meanConf !== null && meanConf < 0.60

            return (
              <span
                title={isKept
                  ? 'Beat grid · KEPT — human-verified, confidence definitive'
                  : needsEye
                  ? `Beat grid — low confidence (${Math.round(meanConf! * 100)}%) · check manually`
                  : meanConf !== null
                  ? `Beat grid · ${Math.round(meanConf * 100)}% confidence`
                  : 'Beat grid'
                }
                style={{ lineHeight: 0 }}
              >
                {isKept ? (
                  // KEPT — gold diamond
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                    style={{ color: 'rgba(201,160,44,0.92)' }}>
                    <path d="M4 0.5 L7.5 4 L4 7.5 L0.5 4 Z"/>
                  </svg>
                ) : needsEye ? (
                  // ⚠ needs-an-eye
                  <svg width="9" height="8" viewBox="0 0 9 8" fill="currentColor"
                    style={{ color: 'rgba(201,160,44,0.85)' }}>
                    <path d="M4.5 0.5 L8.5 7.5 H0.5 Z" strokeWidth="0" fillOpacity="0.85"/>
                    <rect x="4" y="3.2" width="1" height="2.2" rx="0.3" fill="#0d0b08"/>
                    <rect x="4" y="6" width="1" height="1" rx="0.3" fill="#0d0b08"/>
                  </svg>
                ) : (
                  // Teal grid
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                    style={{ color: 'rgba(60,168,161,0.72)' }}>
                    <rect x="0" y="0" width="3" height="3" rx="0.5"/>
                    <rect x="5" y="0" width="3" height="3" rx="0.5"/>
                    <rect x="0" y="5" width="3" height="3" rx="0.5"/>
                    <rect x="5" y="5" width="3" height="3" rx="0.5"/>
                  </svg>
                )}
              </span>
            )
          })()}
        </div>
      </td>

      {/* Title + album */}
      {show('title') && (
        <td className="px-2 max-w-0 overflow-hidden">
          <div className="truncate flex items-baseline gap-1.5 overflow-hidden">
            <span
              className={`italic shrink-0 truncate ${!track.title ? 'not-italic' : ''}`}
              style={{
                fontFamily: "'Fraunces', serif",
                fontSize: 13.5,
                fontWeight: 400,
                color: isSelected ? 'rgb(var(--ink-rgb))' : 'rgb(var(--ink-soft-rgb))',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '60%',
              }}
            >
              {track.title || 'Unknown Title'}
            </span>
            {track.album && (
              <span
                className="font-mono text-muted shrink overflow-hidden"
                style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >{track.album}</span>
            )}
          </div>
        </td>
      )}

      {/* Artist */}
      {show('artist') && (
        <td className="px-2 max-w-0 overflow-hidden">
          <span className="truncate block font-mono text-[13px] text-ink-soft">{track.artist || '—'}</span>
        </td>
      )}

      {/* Genre */}
      {show('genre') && (
        <td className="px-2 max-w-0 overflow-hidden">
          <span className="truncate block font-mono text-[12px] text-muted">{track.genre || '—'}</span>
        </td>
      )}

      {/* Label */}
      {show('label') && (
        <td className="px-2 max-w-0 overflow-hidden">
          <span className="truncate block font-mono text-[12px] text-muted">{track.label || '—'}</span>
        </td>
      )}

      {/* Year */}
      {show('year') && (
        <td className="px-2 font-mono text-[12px] text-muted tabular-nums">{track.year ?? '—'}</td>
      )}

      {/* BPM */}
      {show('bpm') && (
        <td className="px-2 font-mono text-[13px] text-ink-soft tabular-nums">
          {formatBpm(track.bpm)}
        </td>
      )}

      {/* Key */}
      {show('key') && (
        <td className="px-2 font-mono text-[13px] font-bold tabular-nums" style={{ color: blipColor }}>
          {displayKey(track.key, keyNotation) || '—'}
        </td>
      )}

      {/* Energy bars */}
      {show('energy') && (
        <td className="px-2"><EnergyBar energy={track.energy} /></td>
      )}

      {/* Mood pip */}
      {show('mood') && (
        <td className="px-2"><MoodPip mood={track.mood} /></td>
      )}

      {/* Rating */}
      {show('rating') && (
        <td className="px-2"><StarRating rating={track.rating} /></td>
      )}

      {/* Duration */}
      {show('durationSeconds') && (
        <td className="px-2 font-mono text-[13px] text-muted tabular-nums">
          {formatDuration(track.durationSeconds)}
        </td>
      )}

      {/* File format */}
      {show('fileType') && (
        <td className="px-2 font-mono text-[12px] text-muted uppercase">
          {track.fileType?.replace('.', '') || '—'}
        </td>
      )}

      {/* File size */}
      {show('fileSize') && (
        <td className="px-2 font-mono text-[12px] text-muted tabular-nums">
          {formatFileSize(track.fileSize)}
        </td>
      )}

      {/* Bit depth */}
      {show('bitDepth') && (
        <td className="px-2 font-mono text-[12px] text-muted tabular-nums">
          {track.bitDepth ? `${track.bitDepth}b` : '—'}
        </td>
      )}

      {/* Sample rate */}
      {show('sampleRate') && (
        <td className="px-2 font-mono text-[12px] text-muted tabular-nums">
          {formatSampleRate(track.sampleRate)}
        </td>
      )}

      {/* Date modified */}
      {show('updatedAt') && (
        <td className="px-2 font-mono text-[12px] text-muted tabular-nums">
          {formatModified(track.updatedAt)}
        </td>
      )}
    </tr>
  )
}

// Mood labels matching the scale in DJOID_FEATURES.md
const MOOD_LABELS = [
  { min: -1.0, max: -0.6, label: 'Dark',       color: '#4a3860' },
  { min: -0.6, max: -0.2, label: 'Melancholic', color: '#6e5f8a' },
  { min: -0.2, max:  0.2, label: 'Neutral',     color: '#6e6553' },
  { min:  0.2, max:  0.6, label: 'Uplifting',   color: '#c8904a' },
  { min:  0.6, max:  1.0, label: 'Euphoric',    color: '#f5c842' },
]

function getMoodLabel(mood: number): { label: string; color: string } {
  return MOOD_LABELS.find((m) => mood >= m.min && mood <= m.max) ?? MOOD_LABELS[2]
}

/** Compact mood indicator for the Library table row */
function MoodPip({ mood }: { mood: number | null }): JSX.Element {
  if (mood == null) {
    return <div className="w-full h-1.5 rounded-full" style={{ background: 'rgb(var(--border-rgb))', opacity: 0.3 }} />
  }
  const { label, color } = getMoodLabel(mood)
  // Map mood [-1, 1] → left position [0%, 100%]
  const pct = ((mood + 1) / 2) * 100
  return (
    <div
      className="relative w-full rounded-full overflow-hidden"
      style={{ height: 6, background: 'linear-gradient(90deg, #3A3024 0%, #C9A02C 100%)' }}
      title={`${label} (${mood > 0 ? '+' : ''}${mood.toFixed(2)})`}
    >
      <div
        className="absolute top-0 bottom-0 w-1 -translate-x-1/2 rounded-full bg-white"
        style={{ left: `${pct}%`, boxShadow: `0 0 3px ${color}` }}
      />
    </div>
  )
}

function EnergyBar({ energy }: { energy: number | null }): JSX.Element {
  return (
    <div className="flex gap-px items-end" style={{ height: 9 }}>
      {Array.from({ length: 10 }, (_, i) => {
        // Lit segments shade dark→light terracotta (#8E4A2E → #E08A52, ~#C2683E mid).
        const t = i / 9
        const lit = `rgb(${Math.round(142 + 82 * t)}, ${Math.round(74 + 64 * t)}, ${Math.round(46 + 36 * t)})`
        return (
          <div
            key={i}
            className="flex-1"
            style={{
              height: energy != null && i < energy ? `${55 + (i / 9) * 45}%` : '45%',
              background: energy != null && i < energy
                ? lit
                : 'rgb(var(--border-rgb))'  /* H4 — use --rule so full width reads */
            }}
          />
        )
      })}
    </div>
  )
}

function StarRating({ rating }: { rating: number }): JSX.Element {
  return (
    <span className="text-[13px] tracking-[-0.05em] leading-none">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < rating ? 'rgb(var(--accent-rgb))' : 'rgb(var(--ink-rgb) / 0.2)' }}>★</span>
      ))}
    </span>
  )
}

// ── Playlist centroid: synthetic anchor track for compatibility scoring ────────

function playlistCentroid(tracks: Track[]): Partial<Track> {
  const withBpm    = tracks.filter((t) => t.bpm    != null)
  const withEnergy = tracks.filter((t) => t.energy != null)
  const withKey    = tracks.filter((t) => t.key)

  const avgBpm    = withBpm.length    ? withBpm.reduce((s, t) => s + t.bpm!, 0) / withBpm.length       : null
  const avgEnergy = withEnergy.length ? withEnergy.reduce((s, t) => s + t.energy!, 0) / withEnergy.length : null

  // Modal key — most common
  const keyCounts = new Map<string, number>()
  for (const t of withKey) keyCounts.set(t.key!, (keyCounts.get(t.key!) ?? 0) + 1)
  const modalKey = [...keyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return { bpm: avgBpm ?? undefined, energy: avgEnergy ?? undefined, key: modalKey }
}

// ── Suggestions panel ─────────────────────────────────────────────────────────

function SuggestionsPanel({ playlistTracks, allTracks, playlistId, onClose, onAdd, onLoadA }: {
  playlistTracks: Track[]
  allTracks: Track[]
  playlistId: string
  onClose: () => void
  onAdd: (ids: string[]) => void
  onLoadA: (t: Track) => void
}): JSX.Element {
  const inPlaylist = new Set(playlistTracks.map((t) => t.id))
  const anchor     = playlistCentroid(playlistTracks) as Track

  const suggestions = useMemo(() =>
    allTracks
      .filter((t) => !inPlaylist.has(t.id))
      .map((t) => ({ track: t, score: compatibilityScore(anchor, t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTracks, playlistId]
  )

  return (
    <div className="shrink-0 border-t border-border/20 bg-chassis-soft">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/15">
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-accent">suggest</span>
        <span className="font-mono text-[12px] text-muted/60">
          tracks that fit this playlist's harmonic + energy profile
        </span>
        <button
          onClick={() => onAdd(suggestions.map((s) => s.track.id))}
          className="ml-auto font-mono text-[12px] text-muted hover:text-ink transition-colors px-2 py-0.5 rounded hover:bg-ink/[0.06]"
        >
          add all
        </button>
        <button onClick={onClose} className="text-muted hover:text-ink transition-colors font-mono text-xs leading-none px-1">×</button>
      </div>
      <div className="flex overflow-x-auto gap-2 px-3 py-2" style={{ scrollbarWidth: 'none' }}>
        {suggestions.map(({ track, score }) => (
          <div
            key={track.id}
            className="shrink-0 flex flex-col gap-0.5 bg-ink/[0.04] border border-border/25 rounded px-2.5 py-2 group hover:border-border/50 transition-colors"
            style={{ width: 140 }}
          >
            <p className="font-mono text-[13px] text-ink truncate">{track.title || '—'}</p>
            <p className="font-mono text-[12px] text-muted truncate">{track.artist}</p>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="font-mono text-[12px] text-muted tabular-nums">{track.key ?? '—'}</span>
              <span className="font-mono text-[12px] text-muted tabular-nums">{track.bpm?.toFixed(0) ?? '—'}</span>
              <div
                className="flex-1 h-0.5 rounded-full"
                style={{ background: `rgba(var(--accent-rgb), ${0.15 + score * 0.85})` }}
              />
            </div>
            <div className="flex gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onAdd([track.id])}
                className="flex-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft hover:text-ink border border-border/40 rounded py-0.5 transition-colors"
              >
                + add
              </button>
              <button
                onClick={() => onLoadA(track)}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-accent border border-accent/30 rounded px-1.5 py-0.5 hover:bg-accent/10 transition-colors"
              >
                A
              </button>
            </div>
          </div>
        ))}
        {suggestions.length === 0 && (
          <p className="font-mono text-[13px] text-muted/50 italic py-1">No suggestions — library may lack BPM/key data.</p>
        )}
      </div>
    </div>
  )
}
