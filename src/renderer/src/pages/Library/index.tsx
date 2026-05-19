import { useCallback, useMemo, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { FilterBar } from '../../components/FilterBar'
import { BulkEditBar } from '../../components/BulkEditBar'
import type { Track } from '@shared/types'

const COLUMNS: { key: keyof Track; label: string; width: string }[] = [
  { key: 'title', label: 'Title', width: '28%' },
  { key: 'artist', label: 'Artist', width: '18%' },
  { key: 'album', label: 'Album', width: '16%' },
  { key: 'genre', label: 'Genre', width: '10%' },
  { key: 'bpm', label: 'BPM', width: '7%' },
  { key: 'key', label: 'Key', width: '6%' },
  { key: 'rating', label: '★', width: '7%' },
  { key: 'durationSeconds', label: 'Time', width: '8%' }
]

type SortKey = keyof Track
type SortDir = 'asc' | 'desc'

export function LibraryPage(): JSX.Element {
  const { isLoading, selectedTrackIds, setSelectedTrackIds } = useLibraryStore()
  const filteredTracks = useLibraryStore((s) => s.filteredTracks())

  const [sortKey, setSortKey] = useState<SortKey>('artist')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)

  const sorted = useMemo(() => {
    return [...filteredTracks].sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredTracks, sortKey, sortDir])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else { setSortKey(key); setSortDir('asc') }
    },
    [sortKey]
  )

  const handleRowClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.shiftKey && lastClickedId) {
        const ids = sorted.map((t) => t.id)
        const from = ids.indexOf(lastClickedId)
        const to = ids.indexOf(id)
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
        const next = new Set(e.metaKey || e.ctrlKey ? [...selectedTrackIds, ...range] : range)
        setSelectedTrackIds(next)
      } else if (e.metaKey || e.ctrlKey) {
        const next = new Set(selectedTrackIds)
        next.has(id) ? next.delete(id) : next.add(id)
        setSelectedTrackIds(next)
        setLastClickedId(id)
      } else {
        setSelectedTrackIds(new Set([id]))
        setLastClickedId(id)
      }
    },
    [selectedTrackIds, lastClickedId, sorted, setSelectedTrackIds]
  )

  const clearSelection = useCallback(() => {
    setSelectedTrackIds(new Set())
    setLastClickedId(null)
  }, [setSelectedTrackIds])

  const selectedArr = [...selectedTrackIds]
  const showBulkBar = selectedArr.length >= 2

  return (
    <div className="flex flex-col h-full">
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

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-900">
            <tr>
              <th className="w-8 px-2 py-2 border-b border-white/5">
                <input
                  type="checkbox"
                  checked={sorted.length > 0 && sorted.every((t) => selectedTrackIds.has(t.id))}
                  onChange={(e) => setSelectedTrackIds(e.target.checked ? new Set(sorted.map((t) => t.id)) : new Set())}
                  className="accent-accent"
                />
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  onClick={() => handleSort(col.key)}
                  className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white/40 cursor-pointer hover:text-white/70 transition-colors select-none border-b border-white/5"
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
            {sorted.map((track) => (
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
              />
            ))}
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
}

function TrackRow({ track, isSelected, onClick, onCheckbox }: TrackRowProps): JSX.Element {
  return (
    <tr
      onClick={(e) => onClick(e, track.id)}
      className={`cursor-pointer transition-colors border-b border-white/[0.03] group ${
        isSelected ? 'bg-accent/20' : 'hover:bg-white/[0.04]'
      }`}
    >
      <td className="w-8 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onCheckbox(e.target.checked)}
          className="accent-accent"
        />
      </td>
      <td className="px-3 py-1.5 max-w-0" style={{ width: '28%' }}>
        <span className={`truncate block text-sm ${!track.title ? 'text-white/30 italic' : ''}`}>
          {track.title || 'Unknown Title'}
        </span>
      </td>
      <td className="px-3 py-1.5 text-white/80 text-sm max-w-0" style={{ width: '18%' }}>
        <span className="truncate block">{track.artist || '—'}</span>
      </td>
      <td className="px-3 py-1.5 text-white/60 text-sm max-w-0" style={{ width: '16%' }}>
        <span className="truncate block">{track.album || '—'}</span>
      </td>
      <td className="px-3 py-1.5 text-white/60 text-sm truncate" style={{ width: '10%' }}>
        {track.genre || '—'}
      </td>
      <td className="px-3 py-1.5 text-white/60 text-sm tabular-nums" style={{ width: '7%' }}>
        {track.bpm ? track.bpm.toFixed(1) : '—'}
      </td>
      <td className="px-3 py-1.5 text-white/60 font-mono text-xs" style={{ width: '6%' }}>
        {track.key || '—'}
      </td>
      <td className="px-3 py-1.5" style={{ width: '7%' }}>
        <StarRating rating={track.rating} />
      </td>
      <td className="px-3 py-1.5 text-white/40 text-xs tabular-nums" style={{ width: '8%' }}>
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
