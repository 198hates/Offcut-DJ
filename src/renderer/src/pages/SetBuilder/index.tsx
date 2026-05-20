import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore } from '../../store/playerStore'
import { useToastStore } from '../../store/toastStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import type { Playlist, Track } from '@shared/types'

// ── Constants ─────────────────────────────────────────────────────────────────

type ViewMode = 'split' | 'swimlane' | 'timeline'

const CHAPTER_COLORS = [
  '#3CA8A1', '#E05E3B', '#4E7090', '#C9A02C',
  '#874850', '#6E8059', '#B07A4E', '#7B61A8',
  '#4A9B6F', '#B86E72', '#5E8E87', '#C1743C',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(secs: number | null): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60), s = Math.round(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function avgBpm(tracks: Track[]): string {
  const w = tracks.filter((t) => t.bpm != null)
  if (!w.length) return '—'
  return (w.reduce((s, t) => s + t.bpm!, 0) / w.length).toFixed(0)
}

function totalDuration(tracks: Track[]): number {
  return tracks.reduce((s, t) => s + (t.durationSeconds ?? 0), 0)
}

// ── Shared prop type ──────────────────────────────────────────────────────────

interface ViewProps {
  chapters: Playlist[]
  chapterTracks: Map<string, Track[]>
  activeChapterId: string | null
  onSelectChapter: (id: string) => void
  onAddTracks: (chapterId: string, trackIds: string[]) => Promise<void>
  onRemoveTrack: (chapterId: string, trackId: string) => Promise<void>
  onLoadA: (t: Track) => void
  onRenameChapter: (id: string, name: string) => Promise<void>
  onDeleteChapter: (id: string) => Promise<void>
  onReorderChapters: (ordered: string[]) => Promise<void>
  isDraggingTracks: boolean
  draggingTrackIds: string[]
}

// ── SetBuilderPage ────────────────────────────────────────────────────────────

export function SetBuilderPage(): JSX.Element {
  const {
    playlists, tracks,
    createSet, createChapter, reorderChapters,
    addTracksToPlaylist, removeTracksFromPlaylist,
    renamePlaylist, deletePlaylist, loadLibrary,
    isDraggingTracks, draggingTrackIds,
  } = useLibraryStore()
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const showToast  = useToastStore((s) => s.show)

  const sets = useMemo(
    () => playlists.filter((p) => p.isFolder && !p.isAutoGroup).sort((a, b) => a.sortOrder - b.sortOrder),
    [playlists]
  )

  const [activeSetId,     setActiveSetId]     = useState<string | null>(null)
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null)
  const [viewMode,        setViewMode]        = useState<ViewMode>('split')

  // Auto-select first set on load / if active set disappears
  useEffect(() => {
    if (sets.length > 0 && (!activeSetId || !sets.find((s) => s.id === activeSetId))) {
      setActiveSetId(sets[0].id)
      setActiveChapterId(null)
    }
  }, [sets, activeSetId])

  const chapters = useMemo(
    () => playlists
      .filter((p) => p.parentId === activeSetId && !p.isFolder && !p.isSmart)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [playlists, activeSetId]
  )

  // Auto-select first chapter when set changes
  useEffect(() => {
    if (chapters.length > 0 && (!activeChapterId || !chapters.find((c) => c.id === activeChapterId))) {
      setActiveChapterId(chapters[0].id)
    } else if (chapters.length === 0) {
      setActiveChapterId(null)
    }
  }, [chapters, activeChapterId])

  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])

  const chapterTracks = useMemo(() => {
    const map = new Map<string, Track[]>()
    for (const ch of chapters) {
      map.set(ch.id, ch.trackIds.map((id) => trackMap.get(id)).filter(Boolean) as Track[])
    }
    return map
  }, [chapters, trackMap])

  // ── Actions ─────────────────────────────────────────────────────────────
  const handleCreateSet = useCallback(async () => {
    const name = `Set ${sets.length + 1}`
    const s = await createSet(name)
    setActiveSetId(s.id)
    setActiveChapterId(null)
  }, [sets.length, createSet])

  const handleCreateChapter = useCallback(async () => {
    if (!activeSetId) return
    const idx   = chapters.length
    const name  = `Chapter ${idx + 1}`
    const color = CHAPTER_COLORS[idx % CHAPTER_COLORS.length]
    const ch    = await createChapter(activeSetId, name, color)
    setActiveChapterId(ch.id)
  }, [activeSetId, chapters.length, createChapter])

  const handleAddTracks = useCallback(async (chapterId: string, trackIds: string[]) => {
    await addTracksToPlaylist(chapterId, trackIds)
    showToast(`Added ${trackIds.length} track${trackIds.length !== 1 ? 's' : ''}`, 'success')
  }, [addTracksToPlaylist, showToast])

  const handleRemoveTrack = useCallback(async (chapterId: string, trackId: string) => {
    await removeTracksFromPlaylist(chapterId, [trackId])
  }, [removeTracksFromPlaylist])

  const handleRenameChapter = useCallback(async (id: string, name: string) => {
    await renamePlaylist(id, name)
  }, [renamePlaylist])

  const handleDeleteChapter = useCallback(async (id: string) => {
    await deletePlaylist(id)
    if (activeChapterId === id) setActiveChapterId(null)
    await loadLibrary()
  }, [deletePlaylist, loadLibrary, activeChapterId])

  const handleReorderChapters = useCallback(async (ordered: string[]) => {
    if (!activeSetId) return
    await reorderChapters(activeSetId, ordered)
  }, [activeSetId, reorderChapters])

  const handleExportSet = useCallback(async () => {
    if (!chapters.length) { showToast('No chapters to export', 'info'); return }
    for (const ch of chapters) {
      await window.api.library.exportPlaylistM3U(ch.id)
    }
    showToast(`Exported ${chapters.length} chapter${chapters.length !== 1 ? 's' : ''} as M3U`, 'success')
  }, [chapters, showToast])

  const viewProps: ViewProps = {
    chapters, chapterTracks,
    activeChapterId,
    onSelectChapter:   setActiveChapterId,
    onAddTracks:       handleAddTracks,
    onRemoveTrack:     handleRemoveTrack,
    onLoadA:           loadTrackA,
    onRenameChapter:   handleRenameChapter,
    onDeleteChapter:   handleDeleteChapter,
    onReorderChapters: handleReorderChapters,
    isDraggingTracks,
    draggingTrackIds,
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (sets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="space-y-1 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-ink">set builder</p>
          <p className="font-mono text-[10px] text-muted">plan your set as energy arcs · export as playlists</p>
        </div>
        <button
          onClick={handleCreateSet}
          className="px-5 py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[10px] uppercase tracking-[0.15em] rounded transition-colors"
        >
          create first set
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/25 bg-chassis-soft">
        {/* Set selector */}
        <select
          value={activeSetId ?? ''}
          onChange={(e) => { setActiveSetId(e.target.value); setActiveChapterId(null) }}
          className="bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent cursor-pointer"
        >
          {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <button
          onClick={handleCreateSet}
          className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
          title="New set"
        >+ set</button>

        {activeSetId && (
          <button
            onClick={handleCreateChapter}
            className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-accent hover:text-accent/80 border border-accent/30 rounded transition-colors"
          >+ chapter</button>
        )}

        <div className="flex-1" />

        {/* Stats */}
        {chapters.length > 0 && (
          <span className="font-mono text-[9px] text-muted tabular-nums">
            {chapters.length} ch · {chapters.reduce((s, c) => s + c.trackIds.length, 0)} trks
          </span>
        )}

        {/* Export */}
        {chapters.length > 0 && (
          <button
            onClick={handleExportSet}
            className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
            title="Export all chapters as M3U playlists"
          >export m3u</button>
        )}

        {/* View switcher */}
        <div className="flex items-center border border-border/35 rounded overflow-hidden">
          {([
            ['split',    'Split',    SplitIcon],
            ['swimlane', 'Lanes',    SwimlaneIcon],
            ['timeline', 'Timeline', TimelineIcon],
          ] as const).map(([mode, label, Icon]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              title={label}
              className={`flex items-center gap-1 px-2 py-1 font-mono text-[9px] transition-colors ${
                viewMode === mode
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted hover:text-ink hover:bg-ink/5'
              }`}
            >
              <Icon />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {chapters.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <p className="font-mono text-[10px] text-muted">no chapters yet</p>
            <button
              onClick={handleCreateChapter}
              className="px-4 py-2 bg-accent hover:bg-accent/90 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
            >
              add first chapter
            </button>
          </div>
        ) : (
          <>
            {viewMode === 'split'    && <SplitView    {...viewProps} />}
            {viewMode === 'swimlane' && <SwimlaneView {...viewProps} />}
            {viewMode === 'timeline' && <TimelineView {...viewProps} />}
          </>
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View 1: Split ────────────────────────────────────────────────────────────
// Left: chapter list  |  Right: track list + library search
// ═════════════════════════════════════════════════════════════════════════════

function SplitView(p: ViewProps): JSX.Element {
  const activeChapter = p.chapters.find((c) => c.id === p.activeChapterId) ?? null
  const activeTracks  = p.activeChapterId ? (p.chapterTracks.get(p.activeChapterId) ?? []) : []
  const existingIds   = useMemo(() => new Set(activeTracks.map((t) => t.id)), [activeTracks])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: chapter list */}
      <div className="w-56 shrink-0 border-r border-border/25 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {p.chapters.map((ch, idx) => {
            const chTracks  = p.chapterTracks.get(ch.id) ?? []
            const isActive  = ch.id === p.activeChapterId
            const [isDragOver, setIsDragOver] = useState(false)

            return (
              <ChapterListRow
                key={ch.id}
                chapter={ch}
                index={idx}
                tracks={chTracks}
                isActive={isActive}
                isDragOver={isDragOver}
                isDraggingTracks={p.isDraggingTracks}
                draggingTrackIds={p.draggingTrackIds}
                onSelect={() => p.onSelectChapter(ch.id)}
                onDragOver={(v) => setIsDragOver(v)}
                onDrop={(ids) => p.onAddTracks(ch.id, ids)}
                onRename={(name) => p.onRenameChapter(ch.id, name)}
                onDelete={() => p.onDeleteChapter(ch.id)}
              />
            )
          })}
        </div>
      </div>

      {/* Right: tracks + search */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeChapter ? (
          <>
            {/* Chapter header */}
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/20">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: activeChapter.color }} />
              <span className="font-mono text-[10px] font-bold text-ink">{activeChapter.name}</span>
              <span className="font-mono text-[9px] text-muted">
                {activeTracks.length} track{activeTracks.length !== 1 ? 's' : ''}
                {activeTracks.length > 0 && ` · ${fmt(totalDuration(activeTracks))} · avg ${avgBpm(activeTracks)} bpm`}
              </span>
            </div>

            {/* Track list */}
            <div className="flex-1 overflow-y-auto">
              {activeTracks.length === 0 ? (
                <div className="flex items-center justify-center h-32 font-mono text-[10px] text-muted/60 italic">
                  drop tracks here or search below
                </div>
              ) : (
                activeTracks.map((track, i) => (
                  <CompactTrackRow
                    key={track.id}
                    track={track}
                    index={i + 1}
                    accentColor={activeChapter.color}
                    onLoad={() => p.onLoadA(track)}
                    onRemove={() => p.onRemoveTrack(activeChapter.id, track.id)}
                  />
                ))
              )}
            </div>

            {/* Library search */}
            <LibrarySearch
              chapterId={activeChapter.id}
              existingIds={existingIds}
              onAdd={p.onAddTracks}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-full font-mono text-[10px] text-muted/60">
            select a chapter
          </div>
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View 2: Swimlane ─────────────────────────────────────────════════════════
// Horizontally scrollable chapter columns (Kanban style)
// ═════════════════════════════════════════════════════════════════════════════

function SwimlaneView(p: ViewProps): JSX.Element {
  return (
    <div className="flex h-full overflow-x-auto overflow-y-hidden gap-3 p-3">
      {p.chapters.map((ch, idx) => {
        const chTracks = p.chapterTracks.get(ch.id) ?? []
        const isActive = ch.id === p.activeChapterId
        return (
          <SwimlaneColumn
            key={ch.id}
            chapter={ch}
            index={idx}
            tracks={chTracks}
            isActive={isActive}
            isDraggingTracks={p.isDraggingTracks}
            draggingTrackIds={p.draggingTrackIds}
            onSelect={() => p.onSelectChapter(ch.id)}
            onAddTracks={(ids) => p.onAddTracks(ch.id, ids)}
            onRemoveTrack={(tid) => p.onRemoveTrack(ch.id, tid)}
            onLoad={p.onLoadA}
            onRename={(name) => p.onRenameChapter(ch.id, name)}
            onDelete={() => p.onDeleteChapter(ch.id)}
          />
        )
      })}
    </div>
  )
}

function SwimlaneColumn({ chapter, index, tracks, isActive, isDraggingTracks, draggingTrackIds, onSelect, onAddTracks, onRemoveTrack, onLoad, onRename, onDelete }: {
  chapter: Playlist; index: number; tracks: Track[]; isActive: boolean
  isDraggingTracks: boolean; draggingTrackIds: string[]
  onSelect: () => void; onAddTracks: (ids: string[]) => void
  onRemoveTrack: (id: string) => void; onLoad: (t: Track) => void
  onRename: (name: string) => Promise<void>; onDelete: () => Promise<void>
}): JSX.Element {
  const [isDragOver, setIsDragOver] = useState(false)
  const [renaming, setRenaming]     = useState(false)
  const [draftName, setDraftName]   = useState(chapter.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (renaming) inputRef.current?.focus() }, [renaming])

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDraggingTracks && !e.dataTransfer.types.includes('application/x-crate-track-ids')) return
    e.preventDefault(); setIsDragOver(true)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false)
    let ids = isDraggingTracks ? draggingTrackIds : []
    if (!ids.length) { try { ids = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids')) } catch {} }
    if (ids.length) onAddTracks(ids)
  }
  const commitRename = async () => {
    setRenaming(false)
    if (draftName.trim() && draftName !== chapter.name) await onRename(draftName.trim())
    else setDraftName(chapter.name)
  }

  return (
    <div
      className={`w-52 shrink-0 flex flex-col rounded border transition-colors ${
        isActive     ? 'border-border/50 bg-ink/[0.03]' :
        isDragOver   ? 'border-accent/60 bg-accent/5'   : 'border-border/25 bg-ink/[0.02]'
      }`}
      style={{ maxHeight: '100%' }}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={onSelect}
    >
      {/* Column header */}
      <div className="shrink-0 px-2.5 py-2 border-b border-border/20 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: chapter.color }} />
        <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">{index + 1}</span>

        {renaming ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setRenaming(false); setDraftName(chapter.name) } }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none font-mono text-[10px] text-ink"
          />
        ) : (
          <span
            className="flex-1 min-w-0 font-mono text-[10px] font-bold text-ink truncate cursor-text"
            onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true) }}
          >{chapter.name}</span>
        )}

        <span className="font-mono text-[9px] text-muted/60 tabular-nums shrink-0">{tracks.length}</span>
        <button
          onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete chapter "${chapter.name}"?`)) onDelete() }}
          className="shrink-0 text-muted/40 hover:text-red-500 transition-colors font-mono text-xs leading-none ml-0.5"
        >×</button>
      </div>

      {/* Track cards */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {tracks.map((track) => (
          <SwimlaneCard
            key={track.id}
            track={track}
            accentColor={chapter.color}
            onLoad={() => onLoad(track)}
            onRemove={() => onRemoveTrack(track.id)}
          />
        ))}
        {isDragOver && (
          <div className="h-10 rounded border-2 border-dashed border-accent/50 flex items-center justify-center">
            <span className="font-mono text-[9px] text-accent/70">drop here</span>
          </div>
        )}
      </div>

      {/* Add via search */}
      <div className="shrink-0 border-t border-border/20">
        <LibrarySearch
          chapterId={chapter.id}
          existingIds={useMemo(() => new Set(tracks.map((t) => t.id)), [tracks])}
          onAdd={async (_chId, ids) => onAddTracks(ids)}
          compact
        />
      </div>
    </div>
  )
}

function SwimlaneCard({ track, accentColor, onLoad, onRemove }: { track: Track; accentColor: string; onLoad: () => void; onRemove: () => void }): JSX.Element {
  const keyColor = keyBlipColor(track.key)
  return (
    <div
      className="group bg-chassis border border-border/30 rounded p-2 cursor-pointer hover:border-border/60 transition-colors"
      style={{ borderLeftColor: accentColor, borderLeftWidth: 3 }}
      onDoubleClick={onLoad}
    >
      <p className="font-mono text-[10px] text-ink truncate leading-snug">{track.title || '—'}</p>
      <p className="font-mono text-[9px] text-muted truncate leading-snug">{track.artist}</p>
      <div className="flex items-center gap-2 mt-1">
        {track.bpm != null && (
          <span className="font-mono text-[9px] text-muted tabular-nums">{track.bpm.toFixed(0)}</span>
        )}
        {track.key && (
          <span className="font-mono text-[9px] font-bold tabular-nums" style={{ color: keyColor }}>{track.key}</span>
        )}
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="opacity-0 group-hover:opacity-100 text-muted/60 hover:text-red-500 transition-all font-mono text-xs leading-none"
        >×</button>
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View 3: Timeline ─────────────────────────────────────────────────────────
// Top: chapter segments proportional to total duration
// Bottom: tracks of selected chapter
// ═════════════════════════════════════════════════════════════════════════════

function TimelineView(p: ViewProps): JSX.Element {
  const totalDur = useMemo(
    () => p.chapters.reduce((sum, ch) => sum + totalDuration(p.chapterTracks.get(ch.id) ?? []), 0),
    [p.chapters, p.chapterTracks]
  )
  const activeChapter = p.chapters.find((c) => c.id === p.activeChapterId) ?? null
  const activeTracks  = activeChapter ? (p.chapterTracks.get(activeChapter.id) ?? []) : []
  const existingIds   = useMemo(() => new Set(activeTracks.map((t) => t.id)), [activeTracks])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Arc strip ──────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pt-3 pb-0">
        <div className="flex gap-0.5 items-end" style={{ height: 72 }}>
          {p.chapters.map((ch) => {
            const chTracks = p.chapterTracks.get(ch.id) ?? []
            const dur      = totalDuration(chTracks)
            const energyAvg = chTracks.filter((t) => t.energy != null).reduce((s, t, _, a) => s + (t.energy! / a.length), 0) || 5
            const flexBasis = totalDur > 0 ? `${Math.max(4, (dur / totalDur) * 100)}%` : `${100 / p.chapters.length}%`
            const barH      = Math.round(20 + (energyAvg / 10) * 44)
            const isActive  = ch.id === p.activeChapterId
            const [isDragOver, setIsDragOver] = useState(false)

            const handleDragOver = (e: React.DragEvent) => {
              if (!p.isDraggingTracks && !e.dataTransfer.types.includes('application/x-crate-track-ids')) return
              e.preventDefault(); setIsDragOver(true)
            }
            const handleDrop = (e: React.DragEvent) => {
              e.preventDefault(); setIsDragOver(false)
              let ids = p.isDraggingTracks ? p.draggingTrackIds : []
              if (!ids.length) { try { ids = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids')) } catch {} }
              if (ids.length) p.onAddTracks(ch.id, ids)
            }

            return (
              <div
                key={ch.id}
                className="flex flex-col justify-end cursor-pointer group transition-all"
                style={{ flexBasis, minWidth: '4%' }}
                onClick={() => p.onSelectChapter(ch.id)}
                onDragOver={handleDragOver}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
              >
                {/* Energy bar */}
                <div
                  className="w-full rounded-t transition-all"
                  style={{
                    height: barH,
                    background: isDragOver
                      ? 'rgba(var(--accent-rgb), 0.5)'
                      : isActive
                      ? ch.color
                      : ch.color + 'BB',
                    boxShadow: isActive ? `0 0 0 2px ${ch.color}` : undefined,
                    border: isDragOver ? `2px dashed ${ch.color}` : undefined,
                  }}
                />
                {/* Label */}
                <div className="overflow-hidden mt-1" style={{ height: 18 }}>
                  <p
                    className="font-mono text-[8px] uppercase tracking-[0.1em] truncate transition-colors"
                    style={{ color: isActive ? ch.color : 'rgb(var(--muted-rgb))' }}
                  >{ch.name}</p>
                  <p className="font-mono text-[7.5px] text-muted/60 tabular-nums">
                    {chTracks.length}t · {fmt(dur)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {/* BPM arc path */}
        <BpmArc chapters={p.chapters} chapterTracks={p.chapterTracks} />
      </div>

      {/* Divider */}
      <div className="shrink-0 mx-3 border-t border-border/30 mt-2" />

      {/* ── Track list ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeChapter ? (
          <>
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/20">
              <span className="w-2 h-2 rounded-sm" style={{ background: activeChapter.color }} />
              <span className="font-mono text-[10px] font-bold text-ink">{activeChapter.name}</span>
              <span className="font-mono text-[9px] text-muted">
                {activeTracks.length} track{activeTracks.length !== 1 ? 's' : ''}
                {activeTracks.length > 0 && ` · ${fmt(totalDuration(activeTracks))} · avg ${avgBpm(activeTracks)} bpm`}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => { if (window.confirm(`Delete chapter "${activeChapter.name}"?`)) p.onDeleteChapter(activeChapter.id) }}
                className="font-mono text-[9px] text-muted/50 hover:text-red-500 transition-colors"
              >delete chapter</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {activeTracks.map((track, i) => (
                <CompactTrackRow
                  key={track.id}
                  track={track}
                  index={i + 1}
                  accentColor={activeChapter.color}
                  onLoad={() => p.onLoadA(track)}
                  onRemove={() => p.onRemoveTrack(activeChapter.id, track.id)}
                />
              ))}
            </div>
            <LibrarySearch
              chapterId={activeChapter.id}
              existingIds={existingIds}
              onAdd={p.onAddTracks}
            />
          </>
        ) : (
          <div className="flex items-center justify-center flex-1 font-mono text-[10px] text-muted/60">
            select a chapter above
          </div>
        )}
      </div>
    </div>
  )
}

/** Small SVG line chart showing the BPM arc across chapters */
function BpmArc({ chapters, chapterTracks }: { chapters: Playlist[]; chapterTracks: Map<string, Track[]> }): JSX.Element {
  const points = chapters.map((ch) => {
    const trs = chapterTracks.get(ch.id) ?? []
    const w   = trs.filter((t) => t.bpm != null)
    return w.length ? w.reduce((s, t) => s + t.bpm!, 0) / w.length : null
  })

  const valid = points.filter((p): p is number => p !== null)
  if (valid.length < 2) return <></>

  const min  = Math.min(...valid) - 4
  const max  = Math.max(...valid) + 4
  const W    = 1000
  const H    = 16
  const step = W / (points.length - 1)

  const pathD = points.reduce((acc, bpm, i) => {
    if (bpm == null) return acc
    const x = i * step
    const y = H - ((bpm - min) / (max - min)) * H
    return acc + (acc ? ` L${x},${y}` : `M${x},${y}`)
  }, '')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-1" style={{ height: 12 }} preserveAspectRatio="none">
      <path d={pathD} stroke="rgb(var(--accent-rgb) / 0.5)" strokeWidth="20" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared sub-components ────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

/** Chapter row for the Split view left panel */
function ChapterListRow({ chapter, index, tracks, isActive, isDragOver, isDraggingTracks, draggingTrackIds, onSelect, onDragOver, onDrop, onRename, onDelete }: {
  chapter: Playlist; index: number; tracks: Track[]; isActive: boolean; isDragOver: boolean
  isDraggingTracks: boolean; draggingTrackIds: string[]
  onSelect: () => void; onDragOver: (v: boolean) => void; onDrop: (ids: string[]) => void
  onRename: (name: string) => Promise<void>; onDelete: () => Promise<void>
}): JSX.Element {
  const [renaming,   setRenaming]  = useState(false)
  const [draftName,  setDraftName] = useState(chapter.name)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (renaming) inputRef.current?.focus() }, [renaming])

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDraggingTracks && !e.dataTransfer.types.includes('application/x-crate-track-ids')) return
    e.preventDefault(); onDragOver(true)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); onDragOver(false)
    let ids = isDraggingTracks ? draggingTrackIds : []
    if (!ids.length) { try { ids = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids')) } catch {} }
    if (ids.length) onDrop(ids)
  }
  const commitRename = async () => {
    setRenaming(false)
    if (draftName.trim() && draftName !== chapter.name) await onRename(draftName.trim())
    else setDraftName(chapter.name)
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2.5 border-b border-border/15 cursor-pointer group transition-colors ${
        isActive   ? 'bg-accent/[0.07]' :
        isDragOver ? 'bg-accent/[0.05] border-l-2'  : 'hover:bg-ink/[0.04]'
      }`}
      style={{ borderLeftColor: isDragOver ? chapter.color : undefined }}
      onClick={onSelect}
      onDragOver={handleDragOver}
      onDragLeave={() => onDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Color swatch */}
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: chapter.color }} />
      <span className="font-mono text-[9px] text-muted/60 tabular-nums w-4 shrink-0">{index + 1}</span>

      <div className="flex-1 min-w-0">
        {renaming ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setRenaming(false); setDraftName(chapter.name) } }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-transparent border-b border-accent outline-none font-mono text-[10px] text-ink"
          />
        ) : (
          <p
            className={`font-mono text-[10px] truncate ${isActive ? 'font-bold text-ink' : 'text-ink-soft'}`}
            onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true) }}
          >{chapter.name}</p>
        )}
        <p className="font-mono text-[9px] text-muted/60 tabular-nums">
          {tracks.length}t{tracks.length > 0 ? ` · ${avgBpm(tracks)} bpm` : ''}
        </p>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${chapter.name}"?`)) onDelete() }}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted/40 hover:text-red-500 transition-all font-mono text-xs"
      >×</button>
    </div>
  )
}

/** Compact track row used in split and timeline views */
function CompactTrackRow({ track, index, accentColor, onLoad, onRemove }: {
  track: Track; index: number; accentColor: string; onLoad: () => void; onRemove: () => void
}): JSX.Element {
  const keyColor = keyBlipColor(track.key)
  return (
    <div
      className="group flex items-center gap-2 px-3 py-1.5 border-b border-border/15 hover:bg-ink/[0.04] transition-colors"
      style={{ borderLeftColor: accentColor, borderLeftWidth: 2 }}
      onDoubleClick={onLoad}
    >
      <span className="font-mono text-[9px] text-muted/50 tabular-nums w-4 text-right shrink-0">{index}</span>
      <div className="flex-1 min-w-0">
        <p className="font-mono text-[10px] text-ink truncate leading-snug">{track.title || '—'}</p>
        <p className="font-mono text-[9px] text-muted truncate leading-snug">{track.artist}</p>
      </div>
      {track.bpm != null && (
        <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">{track.bpm.toFixed(0)}</span>
      )}
      {track.key && (
        <span className="font-mono text-[9px] font-bold tabular-nums shrink-0" style={{ color: keyColor }}>{track.key}</span>
      )}
      <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">{fmt(track.durationSeconds)}</span>
      <button
        onClick={onRemove}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted/50 hover:text-red-500 transition-all font-mono text-xs leading-none"
      >×</button>
    </div>
  )
}

/** Mini library search panel — filters the full library, click or Enter to add */
function LibrarySearch({ chapterId, existingIds, onAdd, compact }: {
  chapterId: string
  existingIds: Set<string>
  onAdd: (chapterId: string, ids: string[]) => Promise<void>
  compact?: boolean
}): JSX.Element {
  const allTracks = useLibraryStore((s) => s.tracks)
  const [query, setQuery] = useState('')
  const [open,  setOpen]  = useState(false)

  const filtered = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return allTracks
      .filter((t) => !existingIds.has(t.id))
      .filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q)
      )
      .slice(0, compact ? 6 : 10)
  }, [allTracks, query, existingIds, compact])

  const add = async (track: Track) => {
    await onAdd(chapterId, [track.id])
    setQuery('')
  }

  return (
    <div className={`shrink-0 border-t border-border/20 ${compact ? 'p-1.5' : 'p-2'}`}>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="search to add…"
        className={`w-full bg-paper border border-border/35 rounded px-2 py-1 font-mono outline-none focus:border-accent transition-colors placeholder-muted/50 ${compact ? 'text-[9px]' : 'text-[10px]'}`}
      />
      {open && filtered.length > 0 && (
        <div className="mt-1 space-y-px max-h-40 overflow-y-auto">
          {filtered.map((track) => (
            <div
              key={track.id}
              className="flex items-center gap-2 px-2 py-1 hover:bg-ink/[0.06] rounded cursor-pointer"
              onMouseDown={() => add(track)}
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[9.5px] text-ink truncate">{track.title || '—'}</p>
                <p className="font-mono text-[8.5px] text-muted truncate">{track.artist}</p>
              </div>
              {track.bpm != null && <span className="font-mono text-[9px] text-muted shrink-0">{track.bpm.toFixed(0)}</span>}
              {track.key && <span className="font-mono text-[9px] text-muted shrink-0">{track.key}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View switcher icons ───────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function SplitIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="5" height="12" rx="0.5"/>
      <rect x="7" y="0" width="5" height="12" rx="0.5"/>
    </svg>
  )
}

function SwimlaneIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="0" y="0" width="3" height="12" rx="0.5"/>
      <rect x="4.5" y="0" width="3" height="12" rx="0.5"/>
      <rect x="9"  y="0" width="3" height="12" rx="0.5"/>
    </svg>
  )
}

function TimelineIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="0"  y="4" width="3.5" height="5"   rx="0.4"/>
      <rect x="4.5" y="2" width="3"  height="7" rx="0.4"/>
      <rect x="8.5" y="5" width="3.5" height="4" rx="0.4"/>
      <rect x="0"  y="10" width="12"  height="1" rx="0.3"/>
    </svg>
  )
}
