import { useState, useCallback, useRef, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { analyzeAudio } from '../../lib/analyzer'
import type { Track, Playlist } from '@shared/types'

type DuplicateGroup = Track[]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

function pct(n: number, total: number): string {
  if (!total) return ''
  return `${Math.round((n / total) * 100)}%`
}

function scanForDuplicates(tracks: Track[]): DuplicateGroup[] {
  // Primary match: same normalized artist + title
  const byMeta = new Map<string, Track[]>()
  for (const track of tracks) {
    const key = `${normalize(track.artist)}||${normalize(track.title)}`
    if (!key.startsWith('||') && key !== '||') {
      if (!byMeta.has(key)) byMeta.set(key, [])
      byMeta.get(key)!.push(track)
    }
  }

  // Secondary match: same duration (±1s) + same BPM (±0.5) for tracks without title matches
  const alreadyGrouped = new Set<string>()
  const primaryGroups = [...byMeta.values()].filter((g) => g.length > 1)
  for (const g of primaryGroups) for (const t of g) alreadyGrouped.add(t.id)

  const byBpmDuration = new Map<string, Track[]>()
  for (const track of tracks) {
    if (alreadyGrouped.has(track.id) || !track.bpm || !track.durationSeconds) continue
    const dKey = `${Math.round(track.durationSeconds)}|${Math.round(track.bpm * 2) / 2}`
    if (!byBpmDuration.has(dKey)) byBpmDuration.set(dKey, [])
    byBpmDuration.get(dKey)!.push(track)
  }
  const secondaryGroups = [...byBpmDuration.values()].filter((g) => g.length > 1)

  return [...primaryGroups, ...secondaryGroups]
}

// Score a track so the "best" copy has the highest score (more metadata = better)
function trackScore(t: Track): number {
  return (
    (t.bpm != null ? 2 : 0) +
    (t.key ? 2 : 0) +
    (t.cuePoints.length > 0 ? 3 : 0) +
    (t.rating > 0 ? 1 : 0) +
    (t.comment ? 1 : 0) +
    (t.tags.length > 0 ? 1 : 0) +
    (t.durationSeconds != null ? 1 : 0)
  )
}

type AnalysisPhase = 'idle' | 'tags' | 'audio' | 'done'
type BeatPhase = 'idle' | 'running' | 'done'

export function LibraryHealthPage(): JSX.Element {
  const { tracks, playlists, deleteTracks, updateTrack } = useLibraryStore()
  const [dupes, setDupes] = useState<DuplicateGroup[] | null>(null)

  // ── Beat grid analysis ─────────────────────────────────────────────────────
  const [modelStatus, setModelStatus] = useState<{ available: boolean; path: string } | null>(null)
  const [beatPhase, setBeatPhase] = useState<BeatPhase>('idle')
  const [beatProgress, setBeatProgress] = useState({ current: 0, total: 0 })
  const [beatCurrentTitle, setBeatCurrentTitle] = useState('')
  const [beatResult, setBeatResult] = useState<{ updated: number; failed: number } | null>(null)
  const beatCancelRef = useRef(false)

  useEffect(() => {
    window.api.library.beatModelStatus().then(setModelStatus)
  }, [])

  const tracksNeedingBeatgrid = tracks.filter((t) => !t.beatgrid || t.beatgrid.length === 0)

  const startBeatAnalysis = useCallback(async (): Promise<void> => {
    if (!tracksNeedingBeatgrid.length || !modelStatus?.available) return
    beatCancelRef.current = false
    setBeatResult(null)
    setBeatPhase('running')
    setBeatProgress({ current: 0, total: tracksNeedingBeatgrid.length })
    let updated = 0, failed = 0

    for (let i = 0; i < tracksNeedingBeatgrid.length; i++) {
      if (beatCancelRef.current) break
      const track = tracksNeedingBeatgrid[i]
      setBeatProgress({ current: i + 1, total: tracksNeedingBeatgrid.length })
      setBeatCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        await window.api.library.analyzeBeats(track.id)
        updated++
      } catch {
        failed++
      }
    }

    setBeatPhase('done')
    setBeatResult({ updated, failed })
    // Refresh library to show new beatgrid data
    if (updated > 0) await useLibraryStore.getState().loadLibrary()
  }, [tracksNeedingBeatgrid, modelStatus])
  const [missing, setMissing] = useState<Track[] | null>(null)
  const [scanningDupes, setScanningDupes] = useState(false)
  const [scanningMissing, setScanningMissing] = useState(false)
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set())

  // ── Batch analysis ────────────────────────────────────────────────────────
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('idle')
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 })
  const [analysisCurrentTitle, setAnalysisCurrentTitle] = useState('')
  const [analysisResult, setAnalysisResult] = useState<{ updated: number; skipped: number; failed: number } | null>(null)
  const cancelRef = useRef(false)

  const tracksNeedingAnalysis = tracks.filter((t) => !t.bpm || !t.key)
  const tracksNeedingBpm = tracks.filter((t) => !t.bpm).length
  const tracksNeedingKey = tracks.filter((t) => !t.key).length

  const startAnalysis = useCallback(async (): Promise<void> => {
    if (!tracksNeedingAnalysis.length) return
    cancelRef.current = false
    setAnalysisResult(null)
    setAnalysisProgress({ current: 0, total: tracksNeedingAnalysis.length })

    let updated = 0, skipped = 0, failed = 0

    // Phase 1: read embedded tags (fast — no audio decode)
    setAnalysisPhase('tags')
    for (let i = 0; i < tracksNeedingAnalysis.length; i++) {
      if (cancelRef.current) { setAnalysisPhase('idle'); return }
      const track = tracksNeedingAnalysis[i]
      setAnalysisProgress({ current: i + 1, total: tracksNeedingAnalysis.length })
      setAnalysisCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const tags = await window.api.audio.readTags(track.filePath)
        if (tags) {
          const newBpm = (!track.bpm && tags.bpm) ? tags.bpm : track.bpm
          const newKey = (!track.key && tags.key) ? tags.key : track.key
          if (newBpm !== track.bpm || newKey !== track.key) {
            await updateTrack({ id: track.id, bpm: newBpm, key: newKey })
            updated++
          }
        }
      } catch { /* file unreadable — handled in Phase 2 */ }
    }

    // Re-read store snapshot after tag phase so Phase 2 skips already-resolved tracks
    // (We work off tracksNeedingAnalysis from before, but check updated values via closure)
    const stillNeeding = tracksNeedingAnalysis.filter((t) => {
      const current = tracks.find((x) => x.id === t.id) ?? t
      return !current.bpm || !current.key
    })

    if (stillNeeding.length === 0) {
      setAnalysisPhase('done')
      setAnalysisResult({ updated, skipped, failed })
      return
    }

    // Phase 2: audio decode + worker analysis (slow — one at a time)
    setAnalysisPhase('audio')
    setAnalysisProgress({ current: 0, total: stillNeeding.length })
    const ctx = new AudioContext()

    for (let i = 0; i < stillNeeding.length; i++) {
      if (cancelRef.current) break
      const track = stillNeeding[i]
      setAnalysisProgress({ current: i + 1, total: stillNeeding.length })
      setAnalysisCurrentTitle(track.title || track.filePath.split('/').pop() || '')

      try {
        const ab = await window.api.audio.readFile(track.filePath)
        const audioBuffer = await ctx.decodeAudioData(ab)
        const result = await analyzeAudio(audioBuffer)

        const newBpm = (!track.bpm && result.bpm) ? result.bpm : track.bpm
        const newKey = (!track.key && result.key) ? result.key : track.key

        if (newBpm !== track.bpm || newKey !== track.key) {
          await updateTrack({ id: track.id, bpm: newBpm, key: newKey })
          updated++
        } else {
          skipped++
        }
      } catch {
        failed++
      }
    }

    await ctx.close()
    setAnalysisPhase('done')
    setAnalysisResult({ updated, skipped, failed })
  }, [tracksNeedingAnalysis, tracks, updateTrack])

  const scanDuplicates = useCallback((): void => {
    setScanningDupes(true)
    setTimeout(() => {
      setDupes(scanForDuplicates(tracks))
      setSelectedDupes(new Set())
      setScanningDupes(false)
    }, 100)
  }, [tracks])

  const scanMissing = useCallback(async (): Promise<void> => {
    setScanningMissing(true)
    const result = await window.api.library.scanMissingFiles()
    setMissing(result)
    setScanningMissing(false)
  }, [])

  const toggleDupe = (id: string): void =>
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Select all tracks in the group except the "best" one
  const selectExtras = (group: DuplicateGroup): void => {
    const sorted = [...group].sort((a, b) => trackScore(b) - trackScore(a))
    const keepId = sorted[0].id
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      for (const t of group) if (t.id !== keepId) next.add(t.id)
      return next
    })
  }

  // Keep only this track from its group; select all others
  const keepThis = (keepId: string, group: DuplicateGroup): void => {
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      for (const t of group) {
        if (t.id === keepId) next.delete(t.id)
        else next.add(t.id)
      }
      return next
    })
  }

  const selectAllExtras = (): void => {
    if (!dupes) return
    const next = new Set<string>()
    for (const group of dupes) {
      const sorted = [...group].sort((a, b) => trackScore(b) - trackScore(a))
      for (const t of sorted.slice(1)) next.add(t.id)
    }
    setSelectedDupes(next)
  }

  const deleteSelected = async (): Promise<void> => {
    if (!dupes || !selectedDupes.size) return

    // Build removeId → keepId map for each group
    const keepMap = new Map<string, string>()
    for (const group of dupes) {
      const keepTrack = group.find((t) => !selectedDupes.has(t.id))
      if (keepTrack) {
        for (const t of group) {
          if (selectedDupes.has(t.id)) keepMap.set(t.id, keepTrack.id)
        }
      }
    }

    // How many selected tracks live in at least one playlist
    const nonSmartPlaylists = playlists.filter((p) => !p.isSmart)
    const inPlaylists = [...selectedDupes].filter((id) =>
      nonSmartPlaylists.some((p) => p.trackIds.includes(id))
    ).length

    const suffix = selectedDupes.size !== 1 ? 's' : ''
    const msg =
      inPlaylists > 0
        ? `Remove ${selectedDupes.size} track${suffix} from library?\n\n` +
          `${inPlaylists} of them appear in playlists — they will be replaced with the kept version.`
        : `Remove ${selectedDupes.size} track${suffix} from library?`

    if (!window.confirm(msg)) return

    // Replace playlist references before deleting (so CASCADE doesn't strip them)
    for (const [removeId, keepId] of keepMap) {
      await window.api.library.replaceTrackInPlaylists(removeId, keepId)
    }

    const toDelete = [...selectedDupes]
    await deleteTracks(toDelete)
    await useLibraryStore.getState().loadLibrary()   // refresh playlists in store

    const deletedSet = new Set(toDelete)
    setSelectedDupes(new Set())
    setDupes((prev) =>
      prev?.map((g) => g.filter((t) => !deletedSet.has(t.id))).filter((g) => g.length > 1) ?? null
    )
  }

  const deleteMissingTrack = async (id: string): Promise<void> => {
    await deleteTracks([id])
    setMissing((prev) => prev?.filter((t) => t.id !== id) ?? null)
  }

  const deleteAllMissing = async (): Promise<void> => {
    if (!missing?.length) return
    if (!window.confirm(`Remove all ${missing.length} missing file${missing.length !== 1 ? 's' : ''} from library?`)) return
    await deleteTracks(missing.map((t) => t.id))
    setMissing([])
  }

  const totalDupeCount = dupes?.reduce((s, g) => s + g.length, 0) ?? 0

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-3xl">
      <div>
        <h1 className="text-base font-mono font-bold uppercase tracking-[0.12em] text-ink mb-0.5">
          <span className="text-accent mr-2">01</span>library health
        </h1>
        <p className="font-mono text-xs text-muted">scan for issues and keep your library clean</p>
      </div>

      {/* ── BPM + Key Analysis ────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
              <span className="text-accent mr-1.5">02</span>bpm + key analysis
            </h2>
            <p className="font-mono text-[10px] text-muted mt-0.5">
              reads embedded tags first · falls back to audio analysis
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(analysisPhase === 'tags' || analysisPhase === 'audio') && (
              <button
                onClick={() => { cancelRef.current = true }}
                className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors"
              >
                cancel
              </button>
            )}
            <button
              onClick={startAnalysis}
              disabled={analysisPhase === 'tags' || analysisPhase === 'audio' || tracksNeedingAnalysis.length === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
            >
              {analysisPhase === 'tags' ? 'reading tags…'
                : analysisPhase === 'audio' ? 'analysing audio…'
                : analysisPhase === 'done' ? 're-analyse'
                : 'analyse library'}
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <AnalysisStatCard
            label="need analysis"
            value={tracksNeedingAnalysis.length.toLocaleString()}
            sub={`of ${tracks.length.toLocaleString()} tracks`}
            accent={tracksNeedingAnalysis.length > 0}
          />
          <AnalysisStatCard
            label="missing bpm"
            value={tracksNeedingBpm.toLocaleString()}
          />
          <AnalysisStatCard
            label="missing key"
            value={tracksNeedingKey.toLocaleString()}
          />
        </div>

        {/* Progress */}
        {(analysisPhase === 'tags' || analysisPhase === 'audio') && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] text-accent uppercase tracking-[0.1em]">
                {analysisPhase === 'tags' ? 'phase 1 · reading tags' : 'phase 2 · audio analysis'}
              </span>
              <span className="font-mono text-[10px] text-muted tabular-nums">
                {analysisProgress.current} / {analysisProgress.total}
              </span>
            </div>
            {/* Progress bar */}
            <div className="h-1 bg-border/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all"
                style={{ width: `${analysisProgress.total ? (analysisProgress.current / analysisProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="font-mono text-[9px] text-muted truncate">{analysisCurrentTitle}</p>
          </div>
        )}

        {/* Result */}
        {analysisPhase === 'done' && analysisResult && (
          <div className="flex items-center gap-4 font-mono text-[10px]">
            <span className="text-green-600 dark:text-green-400">
              ✓ {analysisResult.updated} updated
            </span>
            {analysisResult.skipped > 0 && (
              <span className="text-muted">{analysisResult.skipped} unchanged</span>
            )}
            {analysisResult.failed > 0 && (
              <span className="text-red-500">{analysisResult.failed} failed</span>
            )}
          </div>
        )}

        {tracksNeedingAnalysis.length === 0 && analysisPhase === 'idle' && tracks.length > 0 && (
          <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> all {tracks.length.toLocaleString()} tracks have bpm and key data
          </p>
        )}
      </section>

      <div className="border-t border-border/20" />

      {/* ── Beat Grid Analysis ────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
              <span className="text-accent mr-1.5">03</span>beat grid analysis
            </h2>
            <p className="font-mono text-[10px] text-muted mt-0.5">
              onnx · beat this! · per-bar tempo, downbeats, confidence
            </p>
          </div>
          <div className="flex items-center gap-2">
            {beatPhase === 'running' && (
              <button
                onClick={() => { beatCancelRef.current = true }}
                className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors"
              >cancel</button>
            )}
            <button
              onClick={startBeatAnalysis}
              disabled={beatPhase === 'running' || !modelStatus?.available || tracksNeedingBeatgrid.length === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
            >
              {beatPhase === 'running' ? 'analysing…' : beatPhase === 'done' ? 're-analyse' : 'analyse beats'}
            </button>
          </div>
        </div>

        {modelStatus && !modelStatus.available && (
          <div className="bg-ink/[0.03] border border-border/30 rounded px-4 py-3 space-y-1.5">
            <p className="font-mono text-[10px] text-muted font-bold uppercase tracking-[0.1em]">model not installed</p>
            <p className="font-mono text-[9.5px] text-muted leading-relaxed">
              Run <span className="text-ink bg-ink/10 px-1 rounded font-bold">python scripts/export-beat-this.py</span> to export the model, then place <span className="text-ink">beat_this.onnx</span> at:
            </p>
            <p className="font-mono text-[9px] text-ink-soft break-all">{modelStatus.path}</p>
          </div>
        )}

        {modelStatus?.available && (
          <div className="grid grid-cols-3 gap-3">
            <AnalysisStatCard
              label="need beat grid"
              value={tracksNeedingBeatgrid.length.toLocaleString()}
              sub={`of ${tracks.length.toLocaleString()} tracks`}
              accent={tracksNeedingBeatgrid.length > 0}
            />
            <AnalysisStatCard
              label="with beat grid"
              value={(tracks.length - tracksNeedingBeatgrid.length).toLocaleString()}
            />
            <AnalysisStatCard
              label="model"
              value="beat this!"
              sub="onnxruntime · coreml"
            />
          </div>
        )}

        {beatPhase === 'running' && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] text-accent uppercase tracking-[0.1em]">analysing beats</span>
              <span className="font-mono text-[10px] text-muted tabular-nums">
                {beatProgress.current} / {beatProgress.total}
              </span>
            </div>
            <div className="h-1 bg-border/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all"
                style={{ width: `${beatProgress.total ? (beatProgress.current / beatProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="font-mono text-[9px] text-muted truncate">{beatCurrentTitle}</p>
          </div>
        )}

        {beatPhase === 'done' && beatResult && (
          <div className="flex items-center gap-4 font-mono text-[10px]">
            <span className="text-green-600 dark:text-green-400">✓ {beatResult.updated} updated</span>
            {beatResult.failed > 0 && <span className="text-red-500">{beatResult.failed} failed</span>}
          </div>
        )}
      </section>

      <div className="border-t border-border/20" />

      {/* ── Duplicate Scanner ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
              <span className="text-accent mr-1.5">04</span>duplicate tracks
            </h2>
            <p className="font-mono text-[10px] text-muted mt-0.5">matches on artist + title, then bpm + duration</p>
          </div>
          <button
            onClick={scanDuplicates}
            disabled={scanningDupes || tracks.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
          >
            {scanningDupes ? 'scanning…' : 'scan for duplicates'}
          </button>
        </div>

        {dupes !== null && (
          dupes.length === 0 ? (
            <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2"><span>✓</span> no duplicates found</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] text-ink-soft">
                  found <span className="text-ink font-bold">{dupes.length}</span> group{dupes.length !== 1 ? 's' : ''}{' '}
                  (<span className="text-ink font-bold">{totalDupeCount}</span> tracks total)
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAllExtras}
                    className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 text-ink-soft hover:text-ink font-mono text-[10px] uppercase tracking-[0.1em] rounded transition-colors"
                    title="Auto-select the lower-quality copy in each group"
                  >
                    auto-select extras
                  </button>
                  {selectedDupes.size > 0 && (
                    <button
                      onClick={deleteSelected}
                      className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors"
                    >
                      remove {selectedDupes.size} selected
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                {dupes.map((group, gi) => (
                  <DuplicateGroupCard
                    key={gi}
                    group={group}
                    selected={selectedDupes}
                    playlists={playlists.filter((p) => !p.isSmart)}
                    onToggle={toggleDupe}
                    onSelectExtras={() => selectExtras(group)}
                    onKeepThis={(id) => keepThis(id, group)}
                  />
                ))}
              </div>
            </div>
          )
        )}
      </section>

      <div className="border-t border-border/20" />

      {/* ── Missing File Scanner ──────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
              <span className="text-accent mr-1.5">05</span>missing files
            </h2>
            <p className="font-mono text-[10px] text-muted mt-0.5">checks which tracks can no longer be found on disk</p>
          </div>
          <button
            onClick={scanMissing}
            disabled={scanningMissing || tracks.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
          >
            {scanningMissing ? 'scanning…' : 'scan for missing files'}
          </button>
        </div>

        {missing !== null && (
          missing.length === 0 ? (
            <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2">
              <span>✓</span> all {tracks.length.toLocaleString()} files found
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] text-ink-soft">
                  <span className="text-red-500 font-bold">{missing.length}</span> missing file{missing.length !== 1 ? 's' : ''}
                </p>
                <button
                  onClick={deleteAllMissing}
                  className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors"
                >
                  remove all from library
                </button>
              </div>
              <div className="space-y-1">
                {missing.map((track) => (
                  <div key={track.id} className="flex items-center gap-3 py-2 px-3 bg-red-600/5 border border-red-600/15 rounded">
                    <div className="flex-1 min-w-0">
                      <p className="font-sans text-xs text-ink truncate">{track.title || 'Unknown'}</p>
                      <p className="font-mono text-[9px] text-muted truncate">{track.filePath}</p>
                    </div>
                    <button
                      onClick={() => deleteMissingTrack(track.id)}
                      className="shrink-0 text-red-500/60 hover:text-red-500 font-mono text-[10px] transition-colors"
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </section>

      {/* ── Library Stats ─────────────────────────────────────────────────── */}
      <div className="border-t border-border/20" />
      <section>
        <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink mb-3">
          <span className="text-accent mr-1.5">06</span>library stats
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="total tracks" value={tracks.length.toLocaleString()} />
          <StatCard label="with bpm"  value={tracks.filter((t) => t.bpm != null).length.toLocaleString()} sub={pct(tracks.filter((t) => t.bpm != null).length, tracks.length)} />
          <StatCard label="with key"  value={tracks.filter((t) => t.key).length.toLocaleString()} sub={pct(tracks.filter((t) => t.key).length, tracks.length)} />
          <StatCard label="with cues" value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.cuePoints.length > 0).length, tracks.length)} />
          <StatCard label="rated"     value={tracks.filter((t) => t.rating > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.rating > 0).length, tracks.length)} />
          <StatCard label="tagged"    value={tracks.filter((t) => t.tags.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.tags.length > 0).length, tracks.length)} />
        </div>
      </section>
    </div>
  )
}

function DuplicateGroupCard({ group, selected, playlists, onToggle, onSelectExtras, onKeepThis }: {
  group: Track[]
  selected: Set<string>
  playlists: Playlist[]
  onToggle: (id: string) => void
  onSelectExtras: () => void
  onKeepThis: (id: string) => void
}): JSX.Element {
  const best    = [...group].sort((a, b) => trackScore(b) - trackScore(a))[0]
  const hasKept = group.some((t) => !selected.has(t.id))

  return (
    <div className="bg-ink/[0.03] border border-border/30 rounded overflow-hidden">
      <div className="px-3 py-2 bg-yellow-400/5 border-b border-border/20 flex items-center justify-between">
        <p className="font-mono text-[10px] text-yellow-600 dark:text-yellow-400 font-bold truncate">
          {group[0].artist} — {group[0].title || '(no title)'}
        </p>
        <button
          onClick={onSelectExtras}
          className="ml-3 shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors"
        >
          select extras
        </button>
      </div>

      {group.map((track) => {
        const isSelected = selected.has(track.id)
        const membership = playlists.filter((p) => p.trackIds.includes(track.id))

        return (
          <div
            key={track.id}
            className={`flex items-start gap-3 px-3 py-2.5 border-b border-border/10 last:border-0 hover:bg-ink/5 ${isSelected ? 'bg-red-500/5' : ''}`}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggle(track.id)}
              className="accent-accent shrink-0 mt-0.5"
            />

            <div className="flex-1 min-w-0">
              <p className="font-sans text-xs text-ink-soft truncate">{track.filePath.split('/').pop()}</p>
              <p className="font-mono text-[9px] text-muted truncate">{track.filePath}</p>

              {/* Playlist membership */}
              {membership.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  {isSelected ? (
                    hasKept ? (
                      <span className="font-mono text-[8px] text-amber-500/90 flex items-center gap-1">
                        <span>↺</span>
                        {membership.length} playlist{membership.length > 1 ? 's' : ''} · will be replaced with kept version
                      </span>
                    ) : (
                      <span className="font-mono text-[8px] text-red-400/80 flex items-center gap-1">
                        <span>✕</span>
                        {membership.length} playlist{membership.length > 1 ? 's' : ''} · will be removed (no kept version selected)
                      </span>
                    )
                  ) : (
                    <>
                      {membership.slice(0, 4).map((pl) => (
                        <span key={pl.id} className="font-mono text-[8px] text-muted/70 flex items-center gap-0.5">
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-sm shrink-0"
                            style={{ background: pl.color || '#8A8474' }}
                          />
                          {pl.name.length > 18 ? pl.name.slice(0, 18) + '…' : pl.name}
                        </span>
                      ))}
                      {membership.length > 4 && (
                        <span className="font-mono text-[8px] text-muted/50">+{membership.length - 4} more</span>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-3 font-mono text-[10px] text-muted tabular-nums pt-0.5">
              {track.bpm != null && <span>{track.bpm.toFixed(1)}</span>}
              {track.durationSeconds != null && (
                <span>{Math.floor(track.durationSeconds / 60)}:{String(Math.round(track.durationSeconds % 60)).padStart(2, '0')}</span>
              )}
              {track.cuePoints.length > 0 && <span className="text-accent/70">{track.cuePoints.length} cues</span>}
              {track.beatgrid.length > 0 && <span className="text-teal-500/70">grid</span>}
              {track.id === best.id && <span className="text-green-600 dark:text-green-400 font-bold">best</span>}
            </div>

            <button
              onClick={() => onKeepThis(track.id)}
              className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-green-600 dark:hover:text-green-400 transition-colors pt-0.5"
            >
              keep
            </button>
          </div>
        )
      })}
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-ink/[0.03] border border-border/30 rounded px-4 py-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted mb-1">{label}</p>
      <p className="font-mono text-xl font-bold text-ink tabular-nums">{value}</p>
      {sub && <p className="font-mono text-[9px] text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

function AnalysisStatCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: boolean
}): JSX.Element {
  return (
    <div className={`border rounded px-4 py-3 ${accent ? 'border-accent/30 bg-accent/5' : 'border-border/30 bg-ink/[0.03]'}`}>
      <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted mb-1">{label}</p>
      <p className={`font-mono text-xl font-bold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</p>
      {sub && <p className="font-mono text-[9px] text-muted mt-0.5">{sub}</p>}
    </div>
  )
}
