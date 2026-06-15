import { useState } from 'react'
import { keyBlipColor } from '../../components/CamelotWheel'
import { acceptsTrackDrop, readTrackIds } from '../../lib/trackDrag'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import type { Playlist, Track } from '@shared/types'
import { type ChapterProfile, type Suggestion, type ViewProps, arcTransition, fitScore, scoreColor } from './model'
import { ChapterHeader } from './ChapterHeader'
import { SuggestionPanel } from './SuggestionPanel'

// ═════════════════════════════════════════════════════════════════════════════
// ── View 2: Swimlane ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export function SwimlaneView(p: ViewProps): JSX.Element {
  // Arc health between columns
  const arcHealth = p.chapters.length > 1
    ? p.chapters.slice(0, -1).map((ch, i) => {
        const a = p.profiles.get(ch.id)
        const b = p.profiles.get(p.chapters[i + 1].id)
        return a && b ? arcTransition(a, b) : null
      })
    : []

  return (
    <div className="flex h-full overflow-x-auto overflow-y-hidden gap-0 p-3">
      {p.chapters.map((ch, idx) => {
        const chTracks = p.chapterTracks.get(ch.id) ?? []
        const profile  = p.profiles.get(ch.id)
        const trans    = idx > 0 ? arcHealth[idx - 1] : null
        return (
          <div key={ch.id} className="flex items-stretch">
            {/* Arc health connector between columns */}
            {trans && (
              <div className="flex flex-col items-center justify-center px-1 shrink-0" style={{ width: 24 }}>
                <div className="flex-1 w-px" style={{ background: trans.color + '40' }} />
                <span className="font-mono text-[10px] rotate-90 my-1" style={{ color: trans.color }} title={trans.label}>
                  {trans.label === 'rough' ? '!' : trans.label === 'ok' ? '~' : '✓'}
                </span>
                <div className="flex-1 w-px" style={{ background: trans.color + '40' }} />
              </div>
            )}
            <SwimlaneColumn
              chapter={ch} tracks={chTracks} profile={profile ?? null}
              isActive={ch.id === p.activeChapterId}
              isDraggingTracks={p.isDraggingTracks} draggingTrackIds={p.draggingTrackIds}
              seedTrack={p.seedTrack}
              suggestions={ch.id === p.activeChapterId ? p.suggestions : []}
              onSelect={() => p.onSelectChapter(ch.id)}
              onAddTracks={(ids) => p.onAddTracks(ch.id, ids)}
              onRemoveTrack={(tid) => p.onRemoveTrack(ch.id, tid)}
              onMagicSort={() => p.onMagicSort(ch.id)}
              onAiSequence={() => p.onAiSequence(ch.id)}
              aiEnabled={p.aiEnabled} aiBusy={p.aiSeqBusyId === ch.id}
              onLoad={p.onLoadA}
              onSetSeed={p.onSetSeed}
              onRename={(name) => p.onRenameChapter(ch.id, name)}
              onDelete={() => p.onDeleteChapter(ch.id)}
            />
          </div>
        )
      })}
    </div>
  )
}

function SwimlaneColumn({ chapter, tracks, profile, isActive, isDraggingTracks, draggingTrackIds, seedTrack, suggestions, onSelect, onAddTracks, onRemoveTrack, onMagicSort, onAiSequence, aiEnabled, aiBusy, onLoad, onSetSeed, onRename, onDelete }: {
  chapter: Playlist; tracks: Track[]; profile: ChapterProfile | null; isActive: boolean
  isDraggingTracks: boolean; draggingTrackIds: string[]
  seedTrack: Track | null; suggestions: Suggestion[]
  onSelect: () => void; onAddTracks: (ids: string[]) => void
  onRemoveTrack: (id: string) => void; onMagicSort: () => void; onLoad: (t: Track) => void
  onAiSequence?: () => void; aiEnabled?: boolean; aiBusy?: boolean
  onSetSeed: (t: Track | null) => void; onRename: (name: string) => void; onDelete: () => void
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
    if (ids.length) onAddTracks(ids)
  }

  const openTrackMenu = useTrackMenuContext()

  return (
    <div
      className={`w-52 shrink-0 flex flex-col rounded border transition-colors ${
        isActive ? 'border-border/50' : isDragOver ? 'border-accent/50 bg-accent/5' : 'border-border/25'
      }`}
      style={{ maxHeight: '100%' }}
      onDragOver={handleDragOver} onDragLeave={() => setIsDragOver(false)} onDrop={handleDrop}
      onClick={onSelect}
    >
      {profile && (
        <ChapterHeader chapter={chapter} profile={profile} compact
          onMagicSort={onMagicSort} onAiSequence={onAiSequence}
          aiEnabled={aiEnabled} aiBusy={aiBusy}
          onRename={onRename} onDelete={onDelete} />
      )}

      <div className="flex-1 overflow-y-auto py-0.5">
        {tracks.map((track) => {
          const keyColor = keyBlipColor(track.key)
          const isSeed   = seedTrack?.id === track.id
          const fScore   = profile && profile.trackCount > 1 ? fitScore(track, profile) : null
          return (
            <div key={track.id}
              className={`group flex flex-col px-2 py-1.5 border-b border-border/10 hover:bg-ink/[0.04] cursor-pointer transition-colors ${isSeed ? 'bg-accent/[0.06]' : ''}`}
              style={{ borderLeftColor: chapter.color, borderLeftWidth: 2 }}
              onDoubleClick={() => onLoad(track)}
              onContextMenu={(e) => openTrackMenu(e, {
                ids: [track.id], track,
                remove: { label: 'Remove from chapter', action: () => onRemoveTrack(track.id) }
              })}
            >
              <div className="flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); onSetSeed(isSeed ? null : track) }}
                  className={`text-[13px] leading-none shrink-0 transition-colors ${isSeed ? 'text-accent' : 'text-muted/30 hover:text-accent/60'}`}>⊕</button>
                <p className="font-mono text-[12px] text-ink truncate flex-1">{track.title || '—'}</p>
                <button onClick={(e) => { e.stopPropagation(); onRemoveTrack(track.id) }}
                  className="opacity-0 group-hover:opacity-100 text-muted/40 hover:text-red-500 font-mono text-xs">×</button>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="font-mono text-[11px] text-muted truncate">{track.artist}</span>
                <div className="flex-1" />
                {track.bpm != null && <span className="font-mono text-[11px] text-muted tabular-nums">{track.bpm.toFixed(0)}</span>}
                {track.key && <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: keyColor }}>{track.key}</span>}
                {fScore != null && (
                  <div className="w-6 h-1 bg-border/20 rounded-full overflow-hidden" title={`Fit ${Math.round(fScore * 100)}%`}>
                    <div className="h-full rounded-full" style={{ width: `${fScore * 100}%`, background: scoreColor(fScore) }} />
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {isDragOver && (
          <div className="m-1.5 h-8 rounded border-2 border-dashed border-accent/50 flex items-center justify-center">
            <span className="font-mono text-[12px] text-accent/70">drop here</span>
          </div>
        )}
      </div>

      <SuggestionPanel
        chapterId={chapter.id} suggestions={suggestions}
        seedTrack={isActive ? seedTrack : null}
        onSetSeed={onSetSeed}
        onAdd={async (_id, ids) => onAddTracks(ids)} compact
      />
    </div>
  )
}
