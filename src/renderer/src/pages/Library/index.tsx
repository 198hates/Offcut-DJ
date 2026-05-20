import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore, useDeckBStore } from '../../store/playerStore'
import { FilterBar } from '../../components/FilterBar'
import { BulkEditBar } from '../../components/BulkEditBar'
import { SetTimeline } from '../../components/SetTimeline'
import { keyBlipColor } from '../../components/CamelotWheel'
import { ContextMenu } from '../../components/ContextMenu'
import { analyzeAudio } from '../../lib/analyzer'
import { magicSort } from '../../lib/compatibility'
import { useToastStore } from '../../store/toastStore'
import type { Track } from '@shared/types'

async function writeTags(ids: string[], showToast: (msg: string, type: 'success' | 'info' | 'error') => void): Promise<void> {
  if (ids.length === 1) {
    const r = await window.api.library.writeTagsToFile(ids[0])
    if (r.skipped)        showToast('Format not supported for tag writing', 'info')
    else if (r.success)   showToast('Tags written to file', 'success')
    else                  showToast(`Write failed: ${r.error}`, 'error')
  } else {
    const r = await window.api.library.writeTagsBulk(ids)
    const parts: string[] = []
    if (r.succeeded > 0) parts.push(`${r.succeeded} updated`)
    if (r.failed > 0)    parts.push(`${r.failed} failed`)
    if (r.skipped > 0)   parts.push(`${r.skipped} skipped`)
    showToast(parts.join(' · ') || 'Nothing to write', r.failed > 0 ? 'error' : 'success')
  }
}

const ROW_HEIGHT    = 32
const HEADER_HEIGHT = 30
const OVERSCAN      = 8

const COLUMNS: { key: keyof Track; label: string; width: string }[] = [
  { key: 'title',           label: 'Title',  width: 'auto' },
  { key: 'artist',          label: 'Artist', width: '130px'},
  { key: 'bpm',             label: 'BPM',    width: '52px' },
  { key: 'key',             label: 'Key',    width: '40px' },
  { key: 'energy',          label: 'Nrg',    width: '56px' },
  { key: 'rating',          label: '★',      width: '52px' },
  { key: 'durationSeconds', label: 'Time',   width: '54px' }
]

type SortKey = keyof Track
type SortDir = 'asc' | 'desc'

export function LibraryPage(): JSX.Element {
  const { isLoading, selectedTrackIds, setSelectedTrackIds, setDragging, clearDragging, activePlaylistId, playlists, deleteTracks, addTracksToPlaylist, updateTrack, reorderPlaylistTracks } = useLibraryStore()
  const showToast = useToastStore((s) => s.show)
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const loadTrackB = useDeckBStore((s) => s.loadTrack)
  const filteredTracks = useLibraryStore((s) => s.filteredTracks())
  const allTracks = useLibraryStore((s) => s.tracks)

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; trackId: string } | null>(null)

  const [sortKey, setSortKey] = useState<SortKey>('artist')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

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

  const start     = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end       = Math.min(sorted.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN)
  const visible   = sorted.slice(start, end)
  const topPad    = start * ROW_HEIGHT
  const bottomPad = Math.max(0, (sorted.length - end) * ROW_HEIGHT)

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
    }
  }, [sorted, lastClickedId, setSelectedTrackIds])

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
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('application/x-crate-track-ids', JSON.stringify(ids))
    setDragging(ids)
  }, [selectedTrackIds, setDragging])

  const handleDragEnd = useCallback(() => clearDragging(), [clearDragging])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track) => {
    e.preventDefault()
    // If the right-clicked track isn't in the current selection, select only it
    if (!selectedTrackIds.has(track.id)) {
      setSelectedTrackIds(new Set([track.id]))
      setLastClickedId(track.id)
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, trackId: track.id })
  }, [selectedTrackIds, setSelectedTrackIds])

  const clearSelection = useCallback(() => {
    setSelectedTrackIds(new Set())
    setLastClickedId(null)
  }, [setSelectedTrackIds])

  // ── Analysis progress ──────────────────────────────────────────────────────
  const [analysisProgress, setAnalysisProgress] = useState<{
    label: string; current: number; total: number; track: string
  } | null>(null)

  const trackLabel = useCallback((t: Track) =>
    t.title || t.artist || t.filePath.split('/').pop() || t.id
  , [])

  const handleAnalyseBpm = useCallback(async (ids: string[]) => {
    const ctx = new AudioContext()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = allTracks.find((x) => x.id === id)
      if (!t) continue
      setAnalysisProgress({ label: 'BPM + key', current: i + 1, total: ids.length, track: trackLabel(t) })
      // Phase 1: embedded tags
      try {
        const tags = await window.api.audio.readTags(t.filePath)
        if (tags) {
          const newBpm = (!t.bpm && tags.bpm) ? tags.bpm : t.bpm
          const newKey = (!t.key && tags.key) ? tags.key : t.key
          if (newBpm !== t.bpm || newKey !== t.key)
            await updateTrack({ id, bpm: newBpm, key: newKey })
        }
      } catch { /* continue */ }
      // Phase 2: audio decode (if bpm, key, OR energy still missing)
      const current = useLibraryStore.getState().tracks.find((x) => x.id === id) ?? t
      if (!current.bpm || !current.key || current.energy == null) {
        try {
          const ab = await window.api.audio.readFile(t.filePath)
          const buf = await ctx.decodeAudioData(ab)
          const result = await analyzeAudio(buf)
          await updateTrack({
            id,
            bpm: result.bpm ?? current.bpm,
            key: result.key ?? current.key,
            energy: result.energy ?? current.energy
          })
        } catch { /* unreadable */ }
      }
    }
    await ctx.close()
    setAnalysisProgress(null)
    showToast(`Analysed ${ids.length} track${ids.length !== 1 ? 's' : ''}`, 'success')
  }, [allTracks, updateTrack, trackLabel, showToast])

  const handleAnalyseEnergy = useCallback(async (ids: string[]) => {
    const ctx = new AudioContext()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = allTracks.find((x) => x.id === id)
      if (!t) continue
      setAnalysisProgress({ label: 'energy', current: i + 1, total: ids.length, track: trackLabel(t) })
      try {
        const ab = await window.api.audio.readFile(t.filePath)
        const buf = await ctx.decodeAudioData(ab)
        const result = await analyzeAudio(buf)
        // Always update energy; also fill any missing bpm/key as a bonus
        const current = useLibraryStore.getState().tracks.find((x) => x.id === id) ?? t
        await updateTrack({
          id,
          energy: result.energy ?? current.energy,
          bpm: result.bpm ?? current.bpm,
          key: result.key ?? current.key
        })
      } catch { /* unreadable */ }
    }
    await ctx.close()
    setAnalysisProgress(null)
    showToast(`Energy scored for ${ids.length} track${ids.length !== 1 ? 's' : ''}`, 'success')
  }, [allTracks, updateTrack, trackLabel, showToast])

  const handleAnalyseBeats = useCallback(async (ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = allTracks.find((x) => x.id === id)
      setAnalysisProgress({
        label: 'beat grid',
        current: i + 1,
        total: ids.length,
        track: t ? trackLabel(t) : ''
      })
      try { await window.api.library.analyzeBeats(id) } catch { /* model missing */ }
    }
    await useLibraryStore.getState().loadLibrary()
    setAnalysisProgress(null)
    showToast(`Beat grid analysed for ${ids.length} track${ids.length !== 1 ? 's' : ''}`, 'success')
  }, [allTracks, trackLabel, showToast])

  const handleMagicSort = useCallback(async () => {
    if (!activePlaylistId) return
    const pl = playlists.find((p) => p.id === activePlaylistId)
    if (!pl || pl.isSmart) return
    const plTracks = pl.trackIds
      .map((id) => allTracks.find((t) => t.id === id))
      .filter((t): t is Track => !!t)
    if (plTracks.length < 2) return
    const { sorted, flagged } = magicSort(plTracks)
    await reorderPlaylistTracks(activePlaylistId, sorted.map((t) => t.id))
    const msg = flagged.size > 0
      ? `Sorted ${sorted.length} tracks · ${flagged.size} hard transition${flagged.size > 1 ? 's' : ''} flagged`
      : `Sorted ${sorted.length} tracks by compatibility`
    showToast(msg, flagged.size > 0 ? 'info' : 'success')
  }, [activePlaylistId, playlists, allTracks, reorderPlaylistTracks, showToast])

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
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <FilterBar />

      {showBulkBar && (
        <BulkEditBar selectedIds={selectedArr} onClearSelection={clearSelection} />
      )}

      {!showBulkBar && (
        <div className="flex items-center gap-1.5 px-3 py-1 border-b border-border/20 shrink-0">
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
            <span className="text-accent mr-1">02</span>
            {activePlaylist ? activePlaylist.name : 'all tracks'}
          </span>
          <span className="font-mono text-[9px] text-muted ml-auto tabular-nums">
            {sorted.length.toLocaleString()} trks
            {selectedTrackIds.size === 1 && ' · 1 selected'}
          </span>
          {activePlaylist && !activePlaylist.isSmart && sorted.length >= 2 && (
            <button
              onClick={handleMagicSort}
              title="Magic Sort — reorder by harmonic + energy compatibility"
              className="ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] text-muted hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor" aria-hidden="true">
                <path d="M0 1.5h6M0 4.5h4M0 7.5h2"/>
                <path d="M7 3L9 4.5L7 6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              sort
            </button>
          )}
        </div>
      )}

      {analysisProgress && (
        <div className="px-3 py-1.5 border-b border-border/20 shrink-0 flex items-center gap-3 bg-accent/[0.04]">
          <span className="font-mono text-[9px] text-accent uppercase tracking-[0.12em] shrink-0 w-16">
            {analysisProgress.label}
          </span>
          <div className="flex-1 h-0.5 bg-border/30 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-150"
              style={{ width: `${analysisProgress.total > 0 ? (analysisProgress.current / analysisProgress.total) * 100 : 0}%` }}
            />
          </div>
          <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">
            {analysisProgress.current}/{analysisProgress.total}
          </span>
          <span className="font-mono text-[9px] text-muted/60 truncate" style={{ maxWidth: 160 }}>
            {analysisProgress.track}
          </span>
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-auto outline-none">
        <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 28 }} />   {/* checkbox */}
            <col style={{ width: 14 }} />   {/* blip */}
            <col style={{ width: 16 }} />   {/* status */}
            {COLUMNS.map((col) => <col key={col.key} style={{ width: col.width }} />)}
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
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="text-left px-2 text-[9px] font-mono font-bold uppercase tracking-[0.18em] text-muted cursor-pointer hover:text-ink transition-colors select-none border-b border-border/30 truncate"
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {isLoading && (
              <tr><td colSpan={COLUMNS.length + 3} className="text-center py-16 text-muted text-xs font-mono">loading library…</td></tr>
            )}
            {!isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 3} className="text-center py-16">
                  <div className="space-y-2">
                    <p className="text-muted text-xs font-mono">no tracks found</p>
                    <p className="text-[10px] font-mono text-muted/60">try adjusting your search or import a library from the sidebar</p>
                  </div>
                </td>
              </tr>
            )}

            {topPad > 0 && (
              <tr aria-hidden="true"><td colSpan={COLUMNS.length + 3} style={{ height: topPad, padding: 0 }} /></tr>
            )}

            {visible.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                isSelected={selectedTrackIds.has(track.id)}
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
              <tr aria-hidden="true"><td colSpan={COLUMNS.length + 3} style={{ height: bottomPad, padding: 0 }} /></tr>
            )}
          </tbody>
        </table>
      </div>

      {timelineTracks.length >= 2 && (
        <SetTimeline tracks={timelineTracks} />
      )}

      {ctxMenu && (() => {
        const ctxIds = selectedTrackIds.size > 0 ? [...selectedTrackIds] : [ctxMenu.trackId]
        const ctxTrack = allTracks.find((t) => t.id === ctxMenu.trackId) ?? null
        const isMulti = ctxIds.length > 1
        const nonSmartPlaylists = playlists.filter((p) => !p.isSmart && !p.isFolder)

        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            sections={[
              {
                items: [
                  {
                    label: 'Load to Deck A',
                    shortcut: '↵',
                    disabled: isMulti,
                    action: () => ctxTrack && loadTrackA(ctxTrack)
                  },
                  {
                    label: 'Load to Deck B',
                    shortcut: '⇧↵',
                    disabled: isMulti,
                    action: () => ctxTrack && loadTrackB(ctxTrack)
                  }
                ]
              },
              {
                items: [
                  {
                    label: 'Add to playlist',
                    submenu: nonSmartPlaylists.map((pl) => ({
                      label: pl.name,
                      action: () => addTracksToPlaylist(pl.id, ctxIds)
                    }))
                  },
                  ...(activePlaylistId && !playlists.find((p) => p.id === activePlaylistId)?.isSmart ? [{
                    label: 'Remove from playlist',
                    action: () => window.api.library.removeTracksFromPlaylist(activePlaylistId, ctxIds)
                      .then(() => useLibraryStore.getState().loadLibrary())
                  }] : [])
                ]
              },
              {
                items: [
                  {
                    label: isMulti ? `Analyse ${ctxIds.length} tracks` : 'Analyse BPM + key',
                    action: () => handleAnalyseBpm(ctxIds)
                  },
                  {
                    label: isMulti ? `Analyse energy (${ctxIds.length})` : 'Analyse energy',
                    action: () => handleAnalyseEnergy(ctxIds)
                  },
                  {
                    label: isMulti ? `Detect beat grid (${ctxIds.length})` : 'Detect beat grid',
                    action: () => handleAnalyseBeats(ctxIds)
                  },
                  {
                    label: isMulti ? `Write tags to file (${ctxIds.length})` : 'Write tags to file',
                    action: () => writeTags(ctxIds, showToast)
                  }
                ]
              },
              {
                items: [
                  {
                    label: 'Open in Finder',
                    disabled: isMulti || !ctxTrack,
                    action: () => ctxTrack && window.api.settings.openInFinder(ctxTrack.filePath)
                  }
                ]
              },
              {
                items: [
                  {
                    label: isMulti ? `Delete ${ctxIds.length} tracks` : 'Delete from library',
                    danger: true,
                    action: async () => {
                      const label = isMulti ? `${ctxIds.length} tracks` : `"${ctxTrack?.title || 'this track'}"`
                      if (!window.confirm(`Remove ${label} from library?`)) return
                      await deleteTracks(ctxIds)
                    }
                  }
                ]
              }
            ]}
          />
        )
      })()}
    </div>
  )
}

// ── TrackRow ──────────────────────────────────────────────────────────────────

interface TrackRowProps {
  track: Track
  isSelected: boolean
  onClick: (e: React.MouseEvent, id: string) => void
  onDoubleClick: (track: Track, e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent, track: Track) => void
  onCheckbox: (checked: boolean) => void
  onDragStart: (e: React.DragEvent, track: Track) => void
  onDragEnd: () => void
}

function TrackRow({ track, isSelected, onClick, onDoubleClick, onContextMenu, onCheckbox, onDragStart, onDragEnd }: TrackRowProps): JSX.Element {
  const blipColor = keyBlipColor(track.key)

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

      {/* Analysis status icons */}
      <td className="w-4">
        <div className="flex flex-col items-center gap-px">
          {track.bpm != null && (
            <span title="BPM analysed" style={{ lineHeight: 0 }}>
              <svg width="9" height="7" viewBox="0 0 9 7" fill="currentColor"
                style={{ color: 'rgb(var(--accent-rgb) / 0.65)' }}>
                <rect x="0"   y="3"   width="2" height="4" rx="0.4"/>
                <rect x="3.5" y="0"   width="2" height="7" rx="0.4"/>
                <rect x="7"   y="1.5" width="2" height="5.5" rx="0.4"/>
              </svg>
            </span>
          )}
          {track.beatgrid.length > 0 && (
            <span title="Beat grid" style={{ lineHeight: 0 }}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                style={{ color: 'rgba(60,168,161,0.72)' }}>
                <rect x="0" y="0" width="3" height="3" rx="0.5"/>
                <rect x="5" y="0" width="3" height="3" rx="0.5"/>
                <rect x="0" y="5" width="3" height="3" rx="0.5"/>
                <rect x="5" y="5" width="3" height="3" rx="0.5"/>
              </svg>
            </span>
          )}
        </div>
      </td>

      {/* Title + album */}
      <td className="px-2 max-w-0 overflow-hidden">
        <div className="truncate">
          <span className={`font-sans text-[12px] font-medium ${isSelected ? 'text-ink' : 'text-ink-soft'} ${!track.title ? 'text-muted italic font-normal text-xs' : ''}`}>
            {track.title || 'Unknown Title'}
          </span>
          {track.album && (
            <span className="ml-1.5 font-mono text-[9px] text-muted truncate">{track.album}</span>
          )}
        </div>
      </td>

      {/* Artist */}
      <td className="px-2 max-w-0 overflow-hidden">
        <span className="truncate block font-mono text-[10px] text-ink-soft">{track.artist || '—'}</span>
      </td>

      {/* BPM */}
      <td className="px-2 font-mono text-[10px] text-ink-soft tabular-nums">
        {track.bpm ? track.bpm.toFixed(1) : '—'}
      </td>

      {/* Key */}
      <td className="px-2 font-mono text-[10px] font-bold tabular-nums" style={{ color: blipColor }}>
        {track.key || '—'}
      </td>

      {/* Energy bars */}
      <td className="px-2">
        <EnergyBar energy={track.energy} />
      </td>

      {/* Rating */}
      <td className="px-2">
        <StarRating rating={track.rating} />
      </td>

      {/* Duration */}
      <td className="px-2 font-mono text-[10px] text-muted tabular-nums">
        {formatDuration(track.durationSeconds)}
      </td>
    </tr>
  )
}

function EnergyBar({ energy }: { energy: number | null }): JSX.Element {
  return (
    <div className="flex gap-px items-end" style={{ height: 9 }}>
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className="flex-1 rounded-sm"
          style={{
            height: energy != null && i < energy ? `${55 + (i / 9) * 45}%` : '55%',
            background: energy != null && i < energy
              ? `rgba(255,77,20,${0.45 + (i / 9) * 0.55})`
              : 'rgb(var(--ink-rgb) / 0.12)'
          }}
        />
      ))}
    </div>
  )
}

function StarRating({ rating }: { rating: number }): JSX.Element {
  return (
    <span className="text-[11px] tracking-[-0.05em] leading-none">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < rating ? 'rgb(var(--accent-rgb))' : 'rgb(var(--ink-rgb) / 0.2)' }}>★</span>
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
