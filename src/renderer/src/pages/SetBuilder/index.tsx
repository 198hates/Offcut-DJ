import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useDeckAStore } from '../../store/playerStore'
import { useToastStore } from '../../store/toastStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import { compatibilityScore, magicSort } from '../../lib/compatibility'
import { setTrackDragData, acceptsTrackDrop, readTrackIds } from '../../lib/trackDrag'
import { GraphView } from './GraphView'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import type { Playlist, Track } from '@shared/types'

// ── Constants ─────────────────────────────────────────────────────────────────

type ViewMode = 'split' | 'swimlane' | 'timeline' | 'graph'

const CHAPTER_COLORS = [
  '#3CA8A1', '#E05E3B', '#4E7090', '#C9A02C',
  '#874850', '#6E8059', '#B07A4E', '#7B61A8',
  '#4A9B6F', '#B86E72', '#5E8E87', '#C1743C',
]

// ── Intelligence types & helpers ──────────────────────────────────────────────

interface ChapterProfile {
  bpmMin: number | null; bpmMax: number | null; bpmAvg: number | null
  energyMin: number | null; energyMax: number | null; energyAvg: number | null
  moodAvg: number | null
  keyCluster: string | null
  duration: number; trackCount: number
}

interface Suggestion {
  track: Track
  seedScore: number    // compatibility against seed track
  fitScore: number     // compatibility against chapter centroid
  score: number        // combined (60/40)
}

interface ArcTransition {
  score: number        // 0–1, higher = smoother
  energyDelta: number  // absolute energy difference between chapters
  bpmDelta: number     // absolute BPM difference
  moodDelta: number    // absolute mood difference (0–2 range)
  label: 'smooth' | 'ok' | 'rough'
  color: string
}

function computeProfile(tracks: Track[]): ChapterProfile {
  const wb = tracks.filter((t) => t.bpm    != null)
  const we = tracks.filter((t) => t.energy != null)
  const wm = tracks.filter((t) => t.mood   != null)
  const keyCounts = new Map<string, number>()
  for (const t of tracks) if (t.key) keyCounts.set(t.key, (keyCounts.get(t.key) ?? 0) + 1)

  return {
    bpmAvg:     wb.length ? wb.reduce((s, t) => s + t.bpm!, 0)    / wb.length : null,
    bpmMin:     wb.length ? Math.min(...wb.map((t) => t.bpm!))     : null,
    bpmMax:     wb.length ? Math.max(...wb.map((t) => t.bpm!))     : null,
    energyAvg:  we.length ? we.reduce((s, t) => s + t.energy!, 0) / we.length : null,
    energyMin:  we.length ? Math.min(...we.map((t) => t.energy!))  : null,
    energyMax:  we.length ? Math.max(...we.map((t) => t.energy!))  : null,
    moodAvg:    wm.length ? wm.reduce((s, t) => s + t.mood!,   0) / wm.length : null,
    keyCluster: keyCounts.size ? [...keyCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null,
    duration:   tracks.reduce((s, t) => s + (t.durationSeconds ?? 0), 0),
    trackCount: tracks.length,
  }
}

/** How well a track fits an existing chapter (scored against its centroid) */
function fitScore(track: Track, profile: ChapterProfile): number {
  const centroid = {
    bpm: profile.bpmAvg, energy: profile.energyAvg,
    key: profile.keyCluster, mood: profile.moodAvg,
  } as Track
  return compatibilityScore(track, centroid)
}

/** Score library tracks as suggestions for a chapter given a seed track */
function buildSuggestions(
  seed: Track, allTracks: Track[], profile: ChapterProfile, excludeIds: Set<string>
): Suggestion[] {
  const centroid = {
    bpm: profile.bpmAvg, energy: profile.energyAvg,
    key: profile.keyCluster, mood: profile.moodAvg,
  } as Track

  return allTracks
    .filter((t) => !excludeIds.has(t.id))
    .map((t) => {
      const sScore = compatibilityScore(seed, t)
      const fScore = compatibilityScore(centroid, t)
      return { track: t, seedScore: sScore, fitScore: fScore, score: 0.6 * sScore + 0.4 * fScore }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
}

/** How smooth is the chapter-to-chapter transition? */
function arcTransition(a: ChapterProfile, b: ChapterProfile): ArcTransition {
  const eDelta = (a.energyAvg != null && b.energyAvg != null)
    ? Math.abs(a.energyAvg - b.energyAvg) : 3
  const bDelta = (a.bpmAvg != null && b.bpmAvg != null)
    ? Math.abs(a.bpmAvg - b.bpmAvg) : 15
  const mDelta = (a.moodAvg != null && b.moodAvg != null)
    ? Math.abs(a.moodAvg - b.moodAvg) : 0.6   // neutral penalty when unknown

  const eScore = Math.max(0, 1 - eDelta / 5)
  const bScore = Math.max(0, 1 - bDelta / 20)
  const mScore = Math.max(0, 1 - mDelta / 1.5)
  const score  = 0.50 * eScore + 0.30 * bScore + 0.20 * mScore

  const label = score > 0.65 ? 'smooth' : score > 0.40 ? 'ok' : 'rough'
  const color  = score > 0.65 ? '#4A9B6F' : score > 0.40 ? '#C9A02C' : '#B86E72'
  return { score, energyDelta: eDelta, bpmDelta: bDelta, moodDelta: mDelta, label, color }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function fmt(secs: number | null): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60), s = Math.round(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fmtBpmRange(p: ChapterProfile): string {
  if (!p.bpmMin || !p.bpmMax) return '—'
  if (Math.round(p.bpmMin) === Math.round(p.bpmMax)) return `${Math.round(p.bpmAvg!)} bpm`
  return `${Math.round(p.bpmMin)}–${Math.round(p.bpmMax)}`
}

function fmtEnergyRange(p: ChapterProfile): string {
  if (p.energyAvg == null) return '—'
  if (p.energyMin === p.energyMax) return `nrg ${p.energyMin}`
  return `nrg ${p.energyMin}–${p.energyMax}`
}

function scoreColor(s: number): string {
  if (s >= 0.70) return '#4A9B6F'
  if (s >= 0.50) return '#C9A02C'
  return '#B86E72'
}

// ── ViewProps ─────────────────────────────────────────────────────────────────

interface ViewProps {
  chapters:       Playlist[]
  chapterTracks:  Map<string, Track[]>
  profiles:       Map<string, ChapterProfile>
  activeChapterId: string | null
  seedTrack:      Track | null
  suggestions:    Suggestion[]
  onSelectChapter:   (id: string) => void
  onAddTracks:       (chapterId: string, trackIds: string[]) => Promise<void>
  onRemoveTrack:     (chapterId: string, trackId: string) => Promise<void>
  onMagicSort:       (chapterId: string) => Promise<void>
  onLoadA:           (t: Track) => void
  onSetSeed:         (track: Track | null) => void
  onRenameChapter:   (id: string, name: string) => Promise<void>
  onDeleteChapter:   (id: string) => Promise<void>
  isDraggingTracks:  boolean
  draggingTrackIds:  string[]
}

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
// ── Shared: ChapterHeader ─────────────────────────────────────────────────────
// Shows profile stats + magic sort button + rename inline
// ═════════════════════════════════════════════════════════════════════════════

function ChapterHeader({ chapter, profile, onMagicSort, onRename, onDelete, compact = false }: {
  chapter: Playlist; profile: ChapterProfile
  onMagicSort: () => void; onRename: (name: string) => void; onDelete: () => void
  compact?: boolean
}): JSX.Element {
  const [renaming,  setRenaming]  = useState(false)
  const [draftName, setDraftName] = useState(chapter.name)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setDraftName(chapter.name) }, [chapter.name])
  useEffect(() => { if (renaming) inputRef.current?.focus() }, [renaming])

  const commit = () => {
    setRenaming(false)
    if (draftName.trim() && draftName !== chapter.name) onRename(draftName.trim())
    else setDraftName(chapter.name)
  }

  return (
    <div className={`flex items-center gap-2 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} border-b border-border/20 bg-chassis-soft`}>
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: chapter.color }} />

      {renaming ? (
        <input ref={inputRef} value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setRenaming(false); setDraftName(chapter.name) } }}
          onBlur={commit}
          className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none font-mono text-[13px] font-bold text-ink"
        />
      ) : (
        <span className="font-mono text-[13px] font-bold text-ink cursor-text flex-1 min-w-0 truncate"
          onDoubleClick={() => setRenaming(true)}>{chapter.name}</span>
      )}

      {/* Profile badges */}
      <div className="flex items-center gap-1.5 shrink-0">
        {profile.bpmAvg != null && (
          <span className="font-mono text-[11px] text-muted tabular-nums" title="BPM range">
            {fmtBpmRange(profile)}
          </span>
        )}
        {profile.energyAvg != null && (
          <span className="font-mono text-[11px] tabular-nums" title="Energy range"
            style={{ color: scoreColor(profile.energyAvg / 10) }}>
            {fmtEnergyRange(profile)}
          </span>
        )}
        {profile.keyCluster && (
          <span className="font-mono text-[11px] font-bold tabular-nums"
            style={{ color: keyBlipColor(profile.keyCluster) }} title="Key cluster">
            {profile.keyCluster}
          </span>
        )}
        <span className="font-mono text-[11px] text-muted/60 tabular-nums">{fmt(profile.duration)}</span>
      </div>

      {/* Magic sort */}
      <button onClick={(e) => { e.stopPropagation(); onMagicSort() }}
        title="Magic Sort — reorder by harmonic + energy compatibility"
        className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded transition-colors">
        sort
      </button>

      <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${chapter.name}"?`)) onDelete() }}
        className="shrink-0 text-muted/40 hover:text-red-500 transition-colors font-mono text-xs leading-none">×</button>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared: CompactTrackRow ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function CompactTrackRow({ track, index, accentColor, fitScoreVal, isSeed, onLoad, onRemove, onSetSeed }: {
  track: Track; index: number; accentColor: string
  fitScoreVal: number | null; isSeed: boolean
  onLoad: () => void; onRemove: () => void; onSetSeed: () => void
}): JSX.Element {
  const keyColor = keyBlipColor(track.key)
  const openTrackMenu = useTrackMenuContext()
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 border-b border-border/15 hover:bg-ink/[0.04] transition-colors ${isSeed ? 'bg-accent/[0.06]' : ''}`}
      style={{ borderLeftColor: accentColor, borderLeftWidth: 2 }}
      onDoubleClick={onLoad}
      onContextMenu={(e) => openTrackMenu(e, {
        ids: [track.id], track,
        remove: { label: 'Remove from chapter', action: onRemove }
      })}
    >
      <span className="font-mono text-[12px] text-muted/50 tabular-nums w-4 text-right shrink-0">{index}</span>

      {/* Seed toggle */}
      <button
        onClick={onSetSeed}
        title={isSeed ? 'Seeding suggestions from this track' : 'Use as seed for suggestions'}
        className={`shrink-0 text-xs leading-none transition-colors ${isSeed ? 'text-accent' : 'text-muted/30 hover:text-accent/60'}`}
      >⊕</button>

      <div className="flex-1 min-w-0">
        <p className="font-mono text-[13px] text-ink truncate leading-snug">{track.title || '—'}</p>
        <p className="font-mono text-[12px] text-muted truncate leading-snug">{track.artist}</p>
      </div>

      {track.bpm  != null && <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">{track.bpm.toFixed(0)}</span>}
      {track.key  && <span className="font-mono text-[12px] font-bold tabular-nums shrink-0" style={{ color: keyColor }}>{track.key}</span>}
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0 hidden sm:inline">{fmt(track.durationSeconds)}</span>

      {/* Fit score bar */}
      {fitScoreVal != null && (
        <div className="w-8 h-1 bg-border/20 rounded-full overflow-hidden shrink-0" title={`Fit: ${Math.round(fitScoreVal * 100)}%`}>
          <div className="h-full rounded-full transition-all" style={{ width: `${fitScoreVal * 100}%`, background: scoreColor(fitScoreVal) }} />
        </div>
      )}

      <button onClick={onRemove}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted/50 hover:text-red-500 transition-all font-mono text-xs leading-none">×</button>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared: SuggestionPanel ───────────────────────────────────────────────────
// Seed mode (ranked by compatibility) + Search mode (text filter)
// ═════════════════════════════════════════════════════════════════════════════

function SuggestionPanel({ chapterId, suggestions, seedTrack, onSetSeed, onAdd, compact }: {
  chapterId: string
  suggestions: Suggestion[]
  seedTrack: Track | null
  onSetSeed: (t: Track | null) => void
  onAdd: (chapterId: string, ids: string[]) => Promise<void>
  compact?: boolean
}): JSX.Element {
  const allTracks   = useLibraryStore((s) => s.tracks)
  const chapterPl   = useLibraryStore((s) => s.playlists.find((p) => p.id === chapterId))
  const existingIds = useMemo(() => new Set(chapterPl?.trackIds ?? []), [chapterPl])

  const [mode,  setMode]  = useState<'suggest' | 'search'>('suggest')
  const [query, setQuery] = useState('')
  const [open,  setOpen]  = useState(false)

  // Search results
  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return allTracks
      .filter((t) => !existingIds.has(t.id))
      .filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q)
      )
      .slice(0, compact ? 6 : 12)
  }, [allTracks, query, existingIds, compact])

  const items: { track: Track; score: number | null }[] = mode === 'suggest'
    ? suggestions.map((s) => ({ track: s.track, score: s.score }))
    : searchResults.map((t) => ({ track: t, score: null }))

  return (
    <div className={`shrink-0 border-t border-border/20 ${compact ? '' : ''}`}>
      {/* Mode toggle + seed indicator */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/15">
        <button onClick={() => setMode('suggest')}
          className={`px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] rounded transition-colors ${mode === 'suggest' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
          ✨ suggest
        </button>
        <button onClick={() => setMode('search')}
          className={`px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] rounded transition-colors ${mode === 'search' ? 'bg-ink/10 text-ink' : 'text-muted hover:text-ink'}`}>
          🔍 search
        </button>
        {seedTrack && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="font-mono text-[11px] text-accent/70 truncate max-w-[100px]"
              title={`Seed: ${seedTrack.title}`}>seed: {seedTrack.title || seedTrack.artist}</span>
            <button onClick={() => onSetSeed(null)} className="text-muted/50 hover:text-red-400 font-mono text-xs">×</button>
          </div>
        )}
      </div>

      {/* Search input (search mode) */}
      {mode === 'search' && (
        <div className="px-2 py-1">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="search library to add…"
            className={`w-full bg-paper border border-border/35 rounded px-2 py-1 font-mono outline-none focus:border-accent transition-colors placeholder-muted/50 ${compact ? 'text-[12px]' : 'text-[13px]'}`}
          />
        </div>
      )}

      {/* Seed mode — no seed yet */}
      {mode === 'suggest' && !seedTrack && (
        <div className="px-3 py-3 text-center">
          <p className="font-mono text-[12px] text-muted/60 italic">
            Click ⊕ on any track above to seed suggestions
          </p>
        </div>
      )}

      {/* Results */}
      {((mode === 'suggest' && seedTrack) || (mode === 'search' && open && query)) && items.length > 0 && (
        <div className={`overflow-y-auto ${compact ? 'max-h-32' : 'max-h-48'}`}>
          {items.map(({ track, score }) => (
            <div key={track.id}
              className="flex items-center gap-2 px-2 py-1 hover:bg-ink/[0.06] cursor-pointer border-b border-border/10 last:border-0"
              onMouseDown={() => onAdd(chapterId, [track.id])}>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[12px] text-ink truncate">{track.title || '—'}</p>
                <p className="font-mono text-[11px] text-muted truncate">{track.artist}</p>
              </div>
              {track.bpm != null && <span className="font-mono text-[12px] text-muted shrink-0 tabular-nums">{track.bpm.toFixed(0)}</span>}
              {track.key && (
                <span className="font-mono text-[12px] font-bold shrink-0 tabular-nums" style={{ color: keyBlipColor(track.key) }}>{track.key}</span>
              )}
              {score != null && (
                <div className="w-8 h-1 bg-border/20 rounded-full overflow-hidden shrink-0" title={`Match: ${Math.round(score * 100)}%`}>
                  <div className="h-full rounded-full" style={{ width: `${score * 100}%`, background: scoreColor(score) }} />
                </div>
              )}
              <span className="text-accent/50 font-mono text-[12px] shrink-0">+</span>
            </div>
          ))}
        </div>
      )}

      {mode === 'suggest' && seedTrack && items.length === 0 && (
        <div className="px-3 py-2">
          <p className="font-mono text-[12px] text-muted/50 italic">No suggestions — library may need BPM/key analysis</p>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// ── View 1: Split ─────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function SplitView(p: ViewProps): JSX.Element {
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

// ═════════════════════════════════════════════════════════════════════════════
// ── View 2: Swimlane ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function SwimlaneView(p: ViewProps): JSX.Element {
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

function SwimlaneColumn({ chapter, tracks, profile, isActive, isDraggingTracks, draggingTrackIds, seedTrack, suggestions, onSelect, onAddTracks, onRemoveTrack, onMagicSort, onLoad, onSetSeed, onRename, onDelete }: {
  chapter: Playlist; tracks: Track[]; profile: ChapterProfile | null; isActive: boolean
  isDraggingTracks: boolean; draggingTrackIds: string[]
  seedTrack: Track | null; suggestions: Suggestion[]
  onSelect: () => void; onAddTracks: (ids: string[]) => void
  onRemoveTrack: (id: string) => void; onMagicSort: () => void; onLoad: (t: Track) => void
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
          onMagicSort={onMagicSort} onRename={onRename} onDelete={onDelete} />
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

// ═════════════════════════════════════════════════════════════════════════════
// ── View 3: Timeline / Arc ────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

function TimelineView(p: ViewProps): JSX.Element {
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

// ═════════════════════════════════════════════════════════════════════════════
// ── TrackBrowserPanel ─────────────────────────────────────────────────────────
// Full library browser docked to the right — drag or click + to add tracks
// ═════════════════════════════════════════════════════════════════════════════

type SortField = 'artist' | 'bpm' | 'key' | 'energy' | 'genre'

function TrackBrowserPanel({ activeChapterId, activeSetId, profiles, seedTrack, onAdd, onLoadA }: {
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
