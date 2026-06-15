import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore } from '../../store/playerStore'
import { useToastStore } from '../../store/toastStore'
import { magicSort } from '../../lib/compatibility'
import { GraphView } from './GraphView'
import { useAiStatus } from '../../hooks/useAiStatus'
import type { Track } from '@shared/types'
import {
  type ViewMode,
  type ChapterProfile,
  type ViewProps,
  CHAPTER_COLORS,
  computeProfile,
  buildSuggestions,
  arcTransition,
  fmt,
} from './model'
import { SplitView } from './SplitView'
import { SwimlaneView } from './SwimlaneView'
import { TimelineView } from './TimelineView'
import { TrackBrowserPanel } from './TrackBrowserPanel'

// ═════════════════════════════════════════════════════════════════════════════
// ── SetBuilderPage ────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export function SetBuilderPage(): JSX.Element {
  const {
    playlists, tracks,
    createSet, createChapter,
    addTracksToPlaylist, removeTracksFromPlaylist, reorderPlaylistTracks,
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
  const [seedTrack,       setSeedTrack]       = useState<Track | null>(null)
  const [showBrowser,     setShowBrowser]     = useState(true)

  // Auto-select first set
  useEffect(() => {
    if (sets.length > 0 && (!activeSetId || !sets.find((s) => s.id === activeSetId))) {
      setActiveSetId(sets[0].id); setActiveChapterId(null)
    }
  }, [sets, activeSetId])

  const chapters = useMemo(
    () => playlists
      .filter((p) => p.parentId === activeSetId && !p.isFolder && !p.isSmart)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [playlists, activeSetId]
  )

  // Auto-select first chapter
  useEffect(() => {
    if (chapters.length > 0 && (!activeChapterId || !chapters.find((c) => c.id === activeChapterId))) {
      setActiveChapterId(chapters[0].id); setSeedTrack(null)
    } else if (chapters.length === 0) {
      setActiveChapterId(null); setSeedTrack(null)
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

  const profiles = useMemo(() => {
    const map = new Map<string, ChapterProfile>()
    for (const ch of chapters) map.set(ch.id, computeProfile(chapterTracks.get(ch.id) ?? []))
    return map
  }, [chapters, chapterTracks])

  // Seed suggestions — recomputed whenever seed or active chapter changes
  const suggestions = useMemo(() => {
    if (!seedTrack || !activeChapterId) return []
    const profile = profiles.get(activeChapterId)
    if (!profile) return []
    const exclude = new Set(chapterTracks.get(activeChapterId)?.map((t) => t.id) ?? [])
    exclude.add(seedTrack.id)
    return buildSuggestions(seedTrack, tracks, profile, exclude)
  }, [seedTrack, activeChapterId, profiles, chapterTracks, tracks])

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleCreateSet = useCallback(async () => {
    const s = await createSet(`Set ${sets.length + 1}`)
    setActiveSetId(s.id); setActiveChapterId(null)
  }, [sets.length, createSet])

  const handleCreateChapter = useCallback(async () => {
    if (!activeSetId) return
    const idx   = chapters.length
    const ch    = await createChapter(activeSetId, `Chapter ${idx + 1}`, CHAPTER_COLORS[idx % CHAPTER_COLORS.length])
    setActiveChapterId(ch.id); setSeedTrack(null)
  }, [activeSetId, chapters.length, createChapter])

  const handleAddTracks = useCallback(async (chapterId: string, trackIds: string[]) => {
    await addTracksToPlaylist(chapterId, trackIds)
    showToast(`Added ${trackIds.length} track${trackIds.length !== 1 ? 's' : ''}`, 'success')
  }, [addTracksToPlaylist, showToast])

  const handleRemoveTrack = useCallback(async (chapterId: string, trackId: string) => {
    await removeTracksFromPlaylist(chapterId, [trackId])
    if (seedTrack?.id === trackId) setSeedTrack(null)
  }, [removeTracksFromPlaylist, seedTrack])

  const handleMagicSort = useCallback(async (chapterId: string) => {
    const trs = chapterTracks.get(chapterId) ?? []
    if (trs.length < 2) { showToast('Need at least 2 tracks to sort', 'info'); return }
    const { sorted, flagged } = magicSort(trs)
    await reorderPlaylistTracks(chapterId, sorted.map((t) => t.id))
    const msg = flagged.size > 0
      ? `Sorted · ${flagged.size} hard transition${flagged.size > 1 ? 's' : ''} flagged`
      : 'Chapter sorted by compatibility'
    showToast(msg, flagged.size > 0 ? 'info' : 'success')
  }, [chapterTracks, reorderPlaylistTracks, showToast])

  // ── AI sequencing ─────────────────────────────────────────────────────────
  const aiEnabled = useAiStatus()
  const [aiSeqBusyId,  setAiSeqBusyId]  = useState<string | null>(null)
  const [aiSeq,        setAiSeq]        = useState<{ chapterId: string; arc: string } | null>(null)

  const handleAiSequence = useCallback(async (chapterId: string) => {
    const trs = chapterTracks.get(chapterId) ?? []
    if (trs.length < 2) { showToast('Need at least 2 tracks to sequence', 'info'); return }
    setAiSeqBusyId(chapterId)
    try {
      const payload = trs.map((t) => ({
        id: t.id, title: t.title || '', artist: t.artist || '', genre: t.genre || '',
        bpm: t.bpm, key: t.key, energy: t.energy, mood: t.mood, durationSecs: t.durationSeconds
      }))
      const { result, error } = await window.api.ai.sequenceSet(payload)
      if (error || !result) { showToast(error ?? 'AI sequencing failed', 'error'); return }
      await reorderPlaylistTracks(chapterId, result.order.map((s) => s.trackId))
      setAiSeq({ chapterId, arc: result.arc })
      showToast('Chapter sequenced by AI', 'success')
    } catch (err) {
      showToast((err as Error).message, 'error')
    } finally {
      setAiSeqBusyId(null)
    }
  }, [chapterTracks, reorderPlaylistTracks, showToast])

  const handleExport = useCallback(async () => {
    if (!chapters.length) { showToast('No chapters to export', 'info'); return }
    for (const ch of chapters) await window.api.library.exportPlaylistM3U(ch.id)
    showToast(`Exported ${chapters.length} chapter${chapters.length !== 1 ? 's' : ''} as M3U`, 'success')
  }, [chapters, showToast])

  const handleExportToOrder = useCallback(async () => {
    if (!chapters.length) { showToast('No chapters to export', 'info'); return }
    const activeSet = sets.find((s) => s.id === activeSetId)
    const title = activeSet?.name ?? 'Set plan'
    const date  = new Date().toISOString().slice(0, 10)
    // Collect all track IDs from all chapters in order
    const allIds = chapters.flatMap((ch) => chapterTracks.get(ch.id)?.map((t) => t.id) ?? [])
    if (!allIds.length) { showToast('No tracks in any chapter', 'info'); return }

    const ro = await window.api.library.createRunningOrder(`${title} · ${date}`)
    const entries: import('@shared/types').OrderEntry[] = allIds.map((id) => ({
      id: crypto.randomUUID(), trackId: id, plannedTransition: null, note: null, flexible: false
    }))
    await window.api.library.updateRunningOrder(ro.id, { entries })
    showToast(`Created running order "${ro.title}" · navigate to Orders to see it`, 'success')
  }, [chapters, chapterTracks, sets, activeSetId, showToast])

  // Quick Set: filter by energy/mood then magic-sort and create a chapter
  const [showQuickSet, setShowQuickSet] = useState(false)
  const [qsEnergy, setQsEnergy] = useState<[number, number]>([6, 9])
  const [qsCount,  setQsCount]  = useState(12)

  const handleQuickSet = useCallback(async () => {
    if (!activeSetId) return
    setShowQuickSet(false)
    // Filter tracks by energy range
    const inRange = tracks.filter((t) =>
      t.energy != null && t.energy >= qsEnergy[0] && t.energy <= qsEnergy[1]
      && t.bpm != null && t.key != null
    )
    if (!inRange.length) { showToast('No fully-analysed tracks in that energy range', 'info'); return }

    // Pick random seed, magic-sort to a chapter-sized selection
    const seed = inRange[Math.floor(Math.random() * inRange.length)]
    const { sorted } = magicSort(inRange)
    // Start from the seed track and take the next qsCount tracks
    const seedIdx = sorted.findIndex((t) => t.id === seed.id)
    const slice = [...sorted.slice(seedIdx), ...sorted.slice(0, seedIdx)].slice(0, qsCount)

    const color = CHAPTER_COLORS[chapters.length % CHAPTER_COLORS.length]
    const name  = `Quick Set · nrg ${qsEnergy[0]}–${qsEnergy[1]}`
    const ch = await createChapter(activeSetId, name, color)
    if (slice.length) await addTracksToPlaylist(ch.id, slice.map((t) => t.id))
    setActiveChapterId(ch.id)
    showToast(`Created "${name}" with ${slice.length} tracks`, 'success')
  }, [activeSetId, tracks, qsEnergy, qsCount, chapters.length, createChapter, addTracksToPlaylist, setActiveChapterId, showToast])

  const handleImportAutoGroups = useCallback(async () => {
    if (!activeSetId) return
    const autoGroups = playlists.filter((p) => p.isAutoGroup && !p.isFolder)
    if (!autoGroups.length) { showToast('No auto groups found — run Auto Group in Analysis first', 'info'); return }
    let created = 0
    for (const [i, ag] of autoGroups.entries()) {
      const color = CHAPTER_COLORS[(chapters.length + i) % CHAPTER_COLORS.length]
      const ch    = await createChapter(activeSetId, ag.name, color)
      if (ag.trackIds.length) await addTracksToPlaylist(ch.id, ag.trackIds)
      created++
    }
    showToast(`Imported ${created} auto group${created !== 1 ? 's' : ''} as chapters`, 'success')
  }, [activeSetId, playlists, chapters.length, createChapter, addTracksToPlaylist, showToast])

  const viewProps: ViewProps = {
    chapters, chapterTracks, profiles,
    activeChapterId, seedTrack, suggestions,
    onSelectChapter:  setActiveChapterId,
    onAddTracks:      handleAddTracks,
    onRemoveTrack:    handleRemoveTrack,
    onMagicSort:      handleMagicSort,
    onAiSequence:     handleAiSequence,
    aiEnabled,
    aiSeqBusyId,
    onLoadA:          loadTrackA,
    onSetSeed:        setSeedTrack,
    onRenameChapter:  (id, name) => renamePlaylist(id, name),
    onDeleteChapter:  async (id) => {
      await deletePlaylist(id)
      if (activeChapterId === id) setActiveChapterId(null)
      await loadLibrary()
    },
    isDraggingTracks, draggingTrackIds,
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (sets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="space-y-1 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-ink">set builder</p>
          <p className="font-mono text-[13px] text-muted">plan your set as energy arcs · export as crates</p>
        </div>
        <button onClick={handleCreateSet}
          className="px-5 py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.15em] rounded transition-colors">
          create first set
        </button>
      </div>
    )
  }

  const arcHealth = chapters.length > 1
    ? chapters.slice(0, -1).map((ch, i) => {
        const a = profiles.get(ch.id)
        const b = profiles.get(chapters[i + 1].id)
        return a && b ? arcTransition(a, b) : null
      })
    : []

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/25 bg-chassis-soft">
        <select
          value={activeSetId ?? ''}
          onChange={(e) => { setActiveSetId(e.target.value); setActiveChapterId(null); setSeedTrack(null) }}
          className="bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[13px] text-ink outline-none focus:border-accent cursor-pointer"
        >
          {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <button onClick={handleCreateSet}
          className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
          title="New set">+ set</button>

        {activeSetId && <>
          <button onClick={handleCreateChapter}
            className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-accent hover:text-accent/80 border border-accent/30 rounded transition-colors">
            + chapter
          </button>

          {/* Quick Set generator */}
          <div className="relative">
            <button
              onClick={() => setShowQuickSet((v) => !v)}
              className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
              title="Auto-generate a chapter from energy/mood criteria">
              quick set
            </button>
            {showQuickSet && (
              <div className="absolute top-8 left-0 z-30 bg-chassis border border-border/40 rounded shadow-xl px-4 py-3 space-y-3 min-w-[200px]">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">quick set</p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-muted w-14 shrink-0">energy</span>
                  <input type="number" min="1" max="10" value={qsEnergy[0]}
                    onChange={(e) => setQsEnergy([Number(e.target.value), qsEnergy[1]])}
                    className="w-12 bg-paper border border-border/40 rounded px-2 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-accent" />
                  <span className="font-mono text-[12px] text-muted/50">–</span>
                  <input type="number" min="1" max="10" value={qsEnergy[1]}
                    onChange={(e) => setQsEnergy([qsEnergy[0], Number(e.target.value)])}
                    className="w-12 bg-paper border border-border/40 rounded px-2 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-accent" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-muted w-14 shrink-0">tracks</span>
                  <input type="number" min="4" max="30" value={qsCount}
                    onChange={(e) => setQsCount(Number(e.target.value))}
                    className="w-16 bg-paper border border-border/40 rounded px-2 py-0.5 font-mono text-[12px] text-ink outline-none focus:border-accent" />
                </div>
                <button onClick={handleQuickSet}
                  className="w-full px-3 py-1.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[12px] uppercase tracking-[0.1em] rounded transition-colors">
                  generate chapter
                </button>
              </div>
            )}
          </div>

          <button onClick={handleImportAutoGroups}
            className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
            title="Import auto-grouped clusters as chapter drafts">
            from groups
          </button>
        </>}

        <div className="flex-1" />

        {/* Arc health summary */}
        {arcHealth.length > 0 && (
          <div className="flex items-center gap-1" title="Chapter transition quality">
            {arcHealth.map((h, i) => h && (
              <span key={i} className="w-1.5 h-3 rounded-sm" style={{ background: h.color }} title={`Transition ${i + 1}→${i + 2}: ${h.label} (Δenergy ${h.energyDelta.toFixed(1)}, Δbpm ${h.bpmDelta.toFixed(0)}, Δmood ${h.moodDelta.toFixed(2)})`} />
            ))}
          </div>
        )}

        {chapters.length > 0 && (
          <span className="font-mono text-[12px] text-muted/60 tabular-nums">
            {chapters.length} ch · {chapters.reduce((s, c) => s + c.trackIds.length, 0)} trks ·{' '}
            {fmt(chapters.reduce((s, ch) => s + (profiles.get(ch.id)?.duration ?? 0), 0))}
          </span>
        )}

        {chapters.length > 0 && (
          <>
            <button onClick={handleExportToOrder}
              className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-accent border border-border/35 hover:border-accent/30 rounded transition-colors"
              title="Create a running order from all chapters">
              → order
            </button>
            <button onClick={handleExport}
              className="px-2 py-1 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/35 rounded transition-colors"
              title="Export all chapters as M3U playlists">
              m3u
            </button>
          </>
        )}

        {/* Library browser toggle */}
        <button
          onClick={() => setShowBrowser((v) => !v)}
          title={showBrowser ? 'Hide library browser' : 'Show library browser'}
          className={`flex items-center gap-1 px-2 py-1 font-mono text-[12px] border rounded transition-colors ${
            showBrowser
              ? 'bg-accent/15 text-accent border-accent/30'
              : 'text-muted border-border/35 hover:text-ink'
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
            <rect x="0" y="0" width="10" height="1.5" rx="0.4"/>
            <rect x="0" y="3" width="10" height="1.5" rx="0.4"/>
            <rect x="0" y="6" width="10" height="1.5" rx="0.4"/>
            <rect x="0" y="9" width="10" height="1"   rx="0.4"/>
          </svg>
          library
        </button>

        {/* View switcher */}
        <div className="flex items-center border border-border/35 rounded overflow-hidden">
          {([['split', 'Split', SplitIcon], ['swimlane', 'Lanes', SwimlaneIcon], ['timeline', 'Arc', TimelineIcon], ['graph', 'Graph', GraphIcon]] as const).map(([mode, label, Icon]) => (
            <button key={mode} onClick={() => setViewMode(mode)} title={label}
              className={`flex items-center gap-1 px-2 py-1 font-mono text-[12px] transition-colors ${
                viewMode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink hover:bg-ink/5'
              }`}>
              <Icon />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── AI arc note ──────────────────────────────────────────────────── */}
      {aiSeq && aiSeq.chapterId === activeChapterId && (
        <div className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-accent/20 bg-accent/[0.05]">
          <span className="shrink-0 text-accent font-mono text-[12px] mt-0.5">✦</span>
          <p className="flex-1 font-mono text-[12px] text-ink/80 leading-relaxed">{aiSeq.arc}</p>
          <button onClick={() => setAiSeq(null)}
            className="shrink-0 text-muted/50 hover:text-ink transition-colors font-mono text-xs leading-none">×</button>
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {chapters.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="font-mono text-[13px] text-muted">no chapters yet</p>
              <button onClick={handleCreateChapter}
                className="px-4 py-2 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
                add first chapter
              </button>
            </div>
          ) : (
            <>
              {viewMode === 'split'    && <SplitView    {...viewProps} />}
              {viewMode === 'swimlane' && <SwimlaneView {...viewProps} />}
              {viewMode === 'timeline' && <TimelineView {...viewProps} />}
              {viewMode === 'graph'    && (
                <GraphView
                  chapters={viewProps.chapters}
                  chapterTracks={viewProps.chapterTracks}
                  profiles={viewProps.profiles}
                  activeChapterId={viewProps.activeChapterId}
                  onAddTracks={viewProps.onAddTracks}
                  onLoadA={viewProps.onLoadA}
                />
              )}
            </>
          )}
        </div>

        {showBrowser && (
          <TrackBrowserPanel
            activeChapterId={activeChapterId}
            activeSetId={activeSetId}
            profiles={profiles}
            seedTrack={seedTrack}
            onAdd={handleAddTracks}
            onLoadA={loadTrackA}
          />
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View switcher icons ───────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function SplitIcon(): JSX.Element {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="5" height="12" rx="0.5"/><rect x="7" y="0" width="5" height="12" rx="0.5"/></svg>
}
function SwimlaneIcon(): JSX.Element {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="0" y="0" width="3" height="12" rx="0.5"/><rect x="4.5" y="0" width="3" height="12" rx="0.5"/><rect x="9" y="0" width="3" height="12" rx="0.5"/></svg>
}
function TimelineIcon(): JSX.Element {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="0" y="4" width="3.5" height="5" rx="0.4"/><rect x="4.5" y="2" width="3" height="7" rx="0.4"/><rect x="8.5" y="5" width="3.5" height="4" rx="0.4"/><rect x="0" y="10" width="12" height="1" rx="0.3"/></svg>
}
function GraphIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="6" r="1.8" fill="currentColor" stroke="none"/>
      <circle cx="1.5" cy="3" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="10.5" cy="3" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="1.5" cy="9" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="10.5" cy="9" r="1.2" fill="currentColor" stroke="none"/>
      <line x1="4.4" y1="4.9" x2="2.5" y2="3.9"/>
      <line x1="7.6" y1="4.9" x2="9.5" y2="3.9"/>
      <line x1="4.4" y1="7.1" x2="2.5" y2="8.1"/>
      <line x1="7.6" y1="7.1" x2="9.5" y2="8.1"/>
    </svg>
  )
}
