import { useState, useMemo } from 'react'
import { acceptsTrackDrop, readTrackIds } from '../../lib/trackDrag'
import type { Playlist } from '@shared/types'
import { type ChapterProfile, type ViewProps, arcTransition, fitScore, fmtBpmRange } from './model'
import { ChapterHeader } from './ChapterHeader'
import { CompactTrackRow } from './CompactTrackRow'
import { SuggestionPanel } from './SuggestionPanel'

// ═════════════════════════════════════════════════════════════════════════════
// ── View 3: Timeline / Arc ────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export function TimelineView(p: ViewProps): JSX.Element {
  const totalDur = useMemo(
    () => p.chapters.reduce((sum, ch) => sum + (p.profiles.get(ch.id)?.duration ?? 0), 0),
    [p.chapters, p.profiles]
  )
  const arcHealth = p.chapters.length > 1
    ? p.chapters.slice(0, -1).map((ch, i) => {
        const a = p.profiles.get(ch.id)
        const b = p.profiles.get(p.chapters[i + 1].id)
        return a && b ? arcTransition(a, b) : null
      })
    : []

  const activeChapter = p.chapters.find((c) => c.id === p.activeChapterId) ?? null
  const activeTracks  = activeChapter ? (p.chapterTracks.get(activeChapter.id) ?? []) : []
  const activeProfile = activeChapter ? p.profiles.get(activeChapter.id) ?? null : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Energy arc strip ── */}
      <div className="shrink-0 px-3 pt-3 pb-0">
        <div className="flex gap-0 items-end" style={{ height: 80 }}>
          {p.chapters.map((ch, idx) => {
            const profile  = p.profiles.get(ch.id)
            const dur      = profile?.duration ?? 0
            const energyAvg = profile?.energyAvg ?? 5
            const flexBasis = totalDur > 0 ? `${Math.max(4, (dur / totalDur) * 100)}%` : `${100 / p.chapters.length}%`
            const barH      = Math.round(16 + (energyAvg / 10) * 56)
            const isActive  = ch.id === p.activeChapterId
            const trans     = idx > 0 ? arcHealth[idx - 1] : null
            const [isDragOver, setIsDragOver] = useState(false)

            const handleDragOver = (e: React.DragEvent) => {
              if (!p.isDraggingTracks && !acceptsTrackDrop(e)) return
              e.preventDefault(); setIsDragOver(true)
            }
            const handleDrop = (e: React.DragEvent) => {
              e.preventDefault(); setIsDragOver(false)
              let ids = p.isDraggingTracks ? p.draggingTrackIds : []
              if (!ids.length) ids = readTrackIds(e)
              if (ids.length) p.onAddTracks(ch.id, ids)
            }

            return (
              <div key={ch.id} className="flex items-end" style={{ flexBasis, minWidth: '4%' }}>
                {/* Arc health connector */}
                {trans && (
                  <div className="flex flex-col items-center justify-end pb-0 shrink-0 self-stretch" style={{ width: 8 }}>
                    <div className="w-px flex-1" style={{ background: trans.color + '50' }} />
                  </div>
                )}
                <div className="flex flex-col justify-end cursor-pointer flex-1 group"
                  onClick={() => p.onSelectChapter(ch.id)}
                  onDragOver={handleDragOver}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                >
                  <div className="w-full rounded-t transition-all"
                    style={{
                      height: barH,
                      background: isDragOver ? `rgba(var(--accent-rgb), 0.5)` : ch.color + (isActive ? '' : 'AA'),
                      boxShadow: isActive ? `0 0 0 2px ${ch.color}` : undefined,
                      outline: isDragOver ? `2px dashed ${ch.color}` : undefined,
                    }}
                  />
                  <div className="mt-1 overflow-hidden" style={{ height: 28 }}>
                    <p className="font-mono text-[11px] uppercase tracking-[0.08em] truncate transition-colors"
                      style={{ color: isActive ? ch.color : 'rgb(var(--muted-rgb))' }}>{ch.name}</p>
                    {profile && (
                      <p className="font-mono text-[10px] text-muted/60 tabular-nums truncate">
                        {profile.trackCount}t · {fmtBpmRange(profile)}
                        {profile.energyAvg != null ? ` · nrg ${profile.energyAvg.toFixed(0)}` : ''}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <BpmArc chapters={p.chapters} profiles={p.profiles} />
      </div>

      <div className="shrink-0 mx-3 border-t border-border/25 mt-1" />

      {/* ── Active chapter tracks ── */}
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
              {activeTracks.map((track, i) => (
                <CompactTrackRow
                  key={track.id} track={track} index={i + 1}
                  accentColor={activeChapter.color}
                  fitScoreVal={activeProfile.trackCount > 1 ? fitScore(track, activeProfile) : null}
                  isSeed={p.seedTrack?.id === track.id}
                  onLoad={() => p.onLoadA(track)}
                  onRemove={() => p.onRemoveTrack(activeChapter.id, track.id)}
                  onSetSeed={() => p.onSetSeed(p.seedTrack?.id === track.id ? null : track)}
                />
              ))}
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
          <div className="flex items-center justify-center flex-1 font-mono text-[13px] text-muted/60">
            select a chapter above
          </div>
        )}
      </div>
    </div>
  )
}

function BpmArc({ chapters, profiles }: { chapters: Playlist[]; profiles: Map<string, ChapterProfile> }): JSX.Element {
  const points = chapters.map((ch) => profiles.get(ch.id)?.bpmAvg ?? null)
  const valid  = points.filter((p): p is number => p !== null)
  if (valid.length < 2) return <></>
  const min = Math.min(...valid) - 4, max = Math.max(...valid) + 4
  const W = 1000, H = 14
  const step = W / (points.length - 1)
  const d = points.reduce((acc, bpm, i) => {
    if (bpm == null) return acc
    const x = i * step, y = H - ((bpm - min) / (max - min)) * H
    return acc + (acc ? ` L${x},${y}` : `M${x},${y}`)
  }, '')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-0.5" style={{ height: 10 }} preserveAspectRatio="none">
      <path d={d} stroke="rgb(var(--accent-rgb) / 0.4)" strokeWidth="18" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
