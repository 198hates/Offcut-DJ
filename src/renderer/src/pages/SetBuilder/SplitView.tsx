import { useState } from 'react'
import { acceptsTrackDrop, readTrackIds } from '../../lib/trackDrag'
import type { Playlist, Track } from '@shared/types'
import { type ChapterProfile, type ViewProps, arcTransition, fitScore, fmtBpmRange } from './model'
import { ChapterHeader } from './ChapterHeader'
import { CompactTrackRow } from './CompactTrackRow'
import { SuggestionPanel } from './SuggestionPanel'

// ═════════════════════════════════════════════════════════════════════════════
// ── View 1: Split ─────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export function SplitView(p: ViewProps): JSX.Element {
  const activeChapter = p.chapters.find((c) => c.id === p.activeChapterId) ?? null
  const activeTracks  = p.activeChapterId ? (p.chapterTracks.get(p.activeChapterId) ?? []) : []
  const activeProfile = p.activeChapterId ? p.profiles.get(p.activeChapterId) ?? null : null

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: chapter list ── */}
      <div className="w-56 shrink-0 border-r border-border/25 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {p.chapters.map((ch, idx) => {
            const chTracks  = p.chapterTracks.get(ch.id) ?? []
            const profile   = p.profiles.get(ch.id)
            const isActive  = ch.id === p.activeChapterId

            // Arc transition indicator on the left list (between chapters)
            const prevCh = idx > 0 ? p.chapters[idx - 1] : null
            const prevProfile = prevCh ? p.profiles.get(prevCh.id) : null
            const trans = (prevProfile && profile) ? arcTransition(prevProfile, profile) : null

            return (
              <div key={ch.id}>
                {trans && (
                  <div className="flex items-center gap-1.5 px-3 py-0.5"
                    title={`Transition: ${trans.label} · Δenergy ${trans.energyDelta.toFixed(1)} · Δbpm ${trans.bpmDelta.toFixed(0)} · Δmood ${trans.moodDelta.toFixed(2)}`}>
                    <div className="flex-1 h-px" style={{ background: trans.color + '60' }} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em]" style={{ color: trans.color }}>
                      {trans.label}
                    </span>
                    <div className="flex-1 h-px" style={{ background: trans.color + '60' }} />
                  </div>
                )}
                <ChapterListRow
                  chapter={ch} tracks={chTracks} profile={profile ?? null}
                  isActive={isActive}
                  isDraggingTracks={p.isDraggingTracks} draggingTrackIds={p.draggingTrackIds}
                  onSelect={() => p.onSelectChapter(ch.id)}
                  onDrop={(ids) => p.onAddTracks(ch.id, ids)}
                  onMagicSort={() => p.onMagicSort(ch.id)}
                  onDelete={() => p.onDeleteChapter(ch.id)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right: track list + suggestion panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeChapter && activeProfile ? (
          <>
            <ChapterHeader
              chapter={activeChapter} profile={activeProfile}
              onMagicSort={() => p.onMagicSort(activeChapter.id)}
              onAiSequence={() => p.onAiSequence(activeChapter.id)}
              aiEnabled={p.aiEnabled} aiBusy={p.aiSeqBusyId === activeChapter.id}
              onRename={(name) => p.onRenameChapter(activeChapter.id, name)}
              onDelete={() => p.onDeleteChapter(activeChapter.id)}
            />
            <div className="flex-1 overflow-y-auto">
              {activeTracks.length === 0 ? (
                <div className="flex items-center justify-center h-24 font-mono text-[13px] text-muted/60 italic">
                  drop tracks here or use the panel below
                </div>
              ) : (
                activeTracks.map((track, i) => (
                  <CompactTrackRow
                    key={track.id} track={track} index={i + 1}
                    accentColor={activeChapter.color}
                    fitScoreVal={activeProfile.trackCount > 1 ? fitScore(track, activeProfile) : null}
                    isSeed={p.seedTrack?.id === track.id}
                    onLoad={() => p.onLoadA(track)}
                    onRemove={() => p.onRemoveTrack(activeChapter.id, track.id)}
                    onSetSeed={() => p.onSetSeed(p.seedTrack?.id === track.id ? null : track)}
                  />
                ))
              )}
            </div>
            <SuggestionPanel
              chapterId={activeChapter.id}
              suggestions={p.suggestions}
              seedTrack={p.seedTrack}
              onSetSeed={p.onSetSeed}
              onAdd={p.onAddTracks}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-full font-mono text-[13px] text-muted/60">
            select a chapter
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function ChapterListRow({ chapter, tracks, profile, isActive, isDraggingTracks, draggingTrackIds, onSelect, onDrop, onMagicSort, onDelete }: {
  chapter: Playlist; tracks: Track[]; profile: ChapterProfile | null; isActive: boolean
  isDraggingTracks: boolean; draggingTrackIds: string[]
  onSelect: () => void; onDrop: (ids: string[]) => void
  onMagicSort: () => void; onDelete: () => void
}): JSX.Element {
  const [isDragOver, setIsDragOver] = useState(false)
  const handleDragOver = (e: React.DragEvent) => {
    if (!isDraggingTracks && !acceptsTrackDrop(e)) return
    e.preventDefault(); setIsDragOver(true)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false)
    let ids = isDraggingTracks ? draggingTrackIds : []
    if (!ids.length) ids = readTrackIds(e)
    if (ids.length) onDrop(ids)
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2.5 border-b border-border/15 cursor-pointer group transition-colors ${
        isActive ? 'bg-accent/[0.07]' : isDragOver ? 'bg-accent/[0.05]' : 'hover:bg-ink/[0.04]'
      }`}
      style={{ borderLeftColor: isDragOver ? chapter.color : undefined, borderLeftWidth: isDragOver ? 2 : undefined }}
      onClick={onSelect}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: chapter.color }} />
      <span className="w-1.5 h-1.5 rounded-full shrink-0 opacity-60" style={{ background: chapter.color }} />
      <div className="flex-1 min-w-0">
        <p className={`font-mono text-[13px] truncate ${isActive ? 'font-bold text-ink' : 'text-ink-soft'}`}>{chapter.name}</p>
        {profile && (
          <p className="font-mono text-[11px] text-muted/60 tabular-nums">
            {tracks.length}t · {fmtBpmRange(profile)}
            {profile.energyAvg != null ? ` · nrg ${profile.energyAvg.toFixed(0)}` : ''}
          </p>
        )}
      </div>
      <button onClick={(e) => { e.stopPropagation(); onMagicSort() }}
        title="Magic Sort this chapter"
        className="opacity-0 group-hover:opacity-100 shrink-0 text-muted/50 hover:text-accent transition-all font-mono text-[12px]">↕</button>
      <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${chapter.name}"?`)) onDelete() }}
        className="opacity-0 group-hover:opacity-100 shrink-0 text-muted/40 hover:text-red-500 transition-all font-mono text-xs">×</button>
    </div>
  )
}
