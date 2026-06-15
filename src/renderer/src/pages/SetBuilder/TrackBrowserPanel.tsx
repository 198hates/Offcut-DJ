import { useState, useMemo } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import { compatibilityScore } from '../../lib/compatibility'
import { setTrackDragData } from '../../lib/trackDrag'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import type { Track } from '@shared/types'
import { type ChapterProfile, type SortField, fitScore, scoreColor } from './model'

// ═════════════════════════════════════════════════════════════════════════════
// ── TrackBrowserPanel ─────────────────────────────────────────────────────────
// Full library browser docked to the right — drag or click + to add tracks
// ═════════════════════════════════════════════════════════════════════════════

export function TrackBrowserPanel({ activeChapterId, activeSetId, profiles, seedTrack, onAdd, onLoadA }: {
  activeChapterId: string | null
  activeSetId:     string | null
  profiles:        Map<string, ChapterProfile>
  seedTrack:       Track | null
  onAdd:           (chapterId: string, trackIds: string[]) => Promise<void>
  onLoadA:         (t: Track) => void
}): JSX.Element {
  const allTracks     = useLibraryStore((s) => s.tracks)
  const playlists     = useLibraryStore((s) => s.playlists)
  const setDragging   = useLibraryStore((s) => s.setDragging)
  const clearDragging = useLibraryStore((s) => s.clearDragging)
  const openTrackMenu = useTrackMenuContext()

  const [query,  setQuery]  = useState('')
  const [sortBy, setSortBy] = useState<SortField>('artist')

  // IDs already in the active chapter (dimmed out)
  const activeChapterIds = useMemo(() => {
    const pl = playlists.find((p) => p.id === activeChapterId)
    return new Set(pl?.trackIds ?? [])
  }, [playlists, activeChapterId])

  // IDs anywhere in the current set (labelled "in set")
  const setTrackIds = useMemo(() => {
    if (!activeSetId) return new Set<string>()
    const chapters = playlists.filter((p) => p.parentId === activeSetId && !p.isFolder)
    const ids = new Set<string>()
    for (const ch of chapters) for (const id of ch.trackIds) ids.add(id)
    return ids
  }, [playlists, activeSetId])

  // Active chapter profile for fit-score display
  const activeProfile = activeChapterId ? profiles.get(activeChapterId) ?? null : null

  const sorted = useMemo(() => {
    let result = allTracks
    if (query.trim()) {
      const q = query.toLowerCase()
      result = result.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q)
      )
    }
    return [...result].sort((a, b) => {
      switch (sortBy) {
        case 'bpm':    return (a.bpm ?? 999) - (b.bpm ?? 999)
        case 'key':    return (a.key ?? 'ZZ').localeCompare(b.key ?? 'ZZ')
        case 'energy': return (b.energy ?? -1) - (a.energy ?? -1)
        case 'genre':  return (a.genre || 'ZZZ').localeCompare(b.genre || 'ZZZ')
        default:       return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)
      }
    })
  }, [allTracks, query, sortBy])

  const handleDragStart = (e: React.DragEvent, track: Track) => {
    setTrackDragData(e, [track.id])
    setDragging([track.id])
  }

  return (
    <div className="w-64 shrink-0 border-l border-border/30 flex flex-col bg-chassis overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-2 pt-2 pb-1.5 border-b border-border/20 space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-muted">
            library · {sorted.length.toLocaleString()}
          </p>
          {!activeChapterId && (
            <p className="font-mono text-[11px] text-muted/50 italic">select a chapter first</p>
          )}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter…"
          className="w-full bg-paper border border-border/35 rounded px-2 py-1 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/40"
        />
        <div className="flex gap-px">
          {(['artist', 'bpm', 'key', 'energy', 'genre'] as const).map((s) => (
            <button key={s} onClick={() => setSortBy(s)}
              className={`flex-1 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] rounded transition-colors ${
                sortBy === s ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'
              }`}>{s}</button>
          ))}
        </div>
      </div>

      {/* Track list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.map((track) => {
          const inChapter = activeChapterIds.has(track.id)
          const inSet     = !inChapter && setTrackIds.has(track.id)
          const keyColor  = keyBlipColor(track.key)
          const fScore    = activeProfile && activeProfile.trackCount > 0
            ? fitScore(track, activeProfile) : null
          const seedScore = seedTrack ? compatibilityScore(seedTrack, track) : null

          return (
            <div
              key={track.id}
              draggable={!inChapter}
              onDragStart={(e) => !inChapter && handleDragStart(e, track)}
              onDragEnd={clearDragging}
              onDoubleClick={() => onLoadA(track)}
              onContextMenu={(e) => openTrackMenu(e, { ids: [track.id], track })}
              className={`group flex items-center gap-1.5 px-2 py-1.5 border-b border-border/10 transition-colors ${
                inChapter
                  ? 'opacity-30 cursor-default'
                  : 'cursor-grab hover:bg-ink/[0.05] active:cursor-grabbing'
              }`}
            >
              {/* Key blip */}
              <span className="w-1 h-1 rounded-full shrink-0" style={{ background: keyColor }} />

              {/* Title + artist */}
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[12px] text-ink truncate leading-tight">{track.title || '—'}</p>
                <div className="flex items-center gap-1">
                  <p className="font-mono text-[11px] text-muted truncate flex-1">{track.artist}</p>
                  {inSet && (
                    <span className="font-mono text-[10px] text-accent/50 shrink-0">set</span>
                  )}
                </div>
              </div>

              {/* BPM */}
              {track.bpm != null && (
                <span className="font-mono text-[11px] text-muted tabular-nums shrink-0">
                  {track.bpm.toFixed(0)}
                </span>
              )}

              {/* Fit/seed score bar */}
              {(fScore != null || seedScore != null) && !inChapter && (
                <div className="w-5 h-1 bg-border/20 rounded-full overflow-hidden shrink-0"
                  title={seedScore != null
                    ? `Seed match: ${Math.round(seedScore * 100)}%`
                    : `Chapter fit: ${Math.round((fScore ?? 0) * 100)}%`
                  }>
                  <div className="h-full rounded-full"
                    style={{
                      width: `${((seedScore ?? fScore ?? 0)) * 100}%`,
                      background: scoreColor(seedScore ?? fScore ?? 0)
                    }}
                  />
                </div>
              )}

              {/* Add button */}
              {activeChapterId && !inChapter && (
                <button
                  onClick={() => onAdd(activeChapterId, [track.id])}
                  className="shrink-0 opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center rounded bg-accent/20 hover:bg-accent/40 text-accent font-mono text-[13px] leading-none transition-all"
                  title="Add to chapter"
                >+</button>
              )}
            </div>
          )
        })}

        {sorted.length === 0 && (
          <div className="flex items-center justify-center h-20">
            <p className="font-mono text-[13px] text-muted/50 italic">no tracks match</p>
          </div>
        )}
      </div>
    </div>
  )
}
