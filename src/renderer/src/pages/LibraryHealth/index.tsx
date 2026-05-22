import { useState, useCallback, useRef, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { analyzeAudio, generateCuesForFile } from '../../lib/analyzer'
import { generateBeatgrid } from '../../lib/compatibility'
import { dbscan, clusterName, clusterKeyLabel } from '../../lib/clustering'
import { SmartFixesPage } from '../SmartFixes'
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
  const [tab, setTab] = useState<'health' | 'fixes'>('health')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-0 px-3 pt-2 pb-0 border-b border-border/20">
        {([['health', 'Library Health'], ['fixes', 'Smart Fixes']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] border-b-2 transition-colors -mb-px ${
              tab === id
                ? 'text-accent border-accent'
                : 'text-muted border-transparent hover:text-ink'
            }`}
          >{label}</button>
        ))}
      </div>
      {tab === 'health' ? <HealthTab /> : <SmartFixesPage />}
    </div>
  )
}

function HealthTab(): JSX.Element {
  const { tracks, playlists, deleteTracks, updateTrack } = useLibraryStore()
  const [dupes, setDupes] = useState<DuplicateGroup[] | null>(null)

  // ── Beat grid analysis ─────────────────────────────────────────────────────
  const [modelStatus, setModelStatus] = useState<{ available: boolean; path: string } | null>(null)
  const [beatPhase, setBeatPhase] = useState<BeatPhase>('idle')
  const [beatProgress, setBeatProgress] = useState({ current: 0, total: 0 })
  const [beatCurrentTitle, setBeatCurrentTitle] = useState('')
  const [beatResult, setBeatResult] = useState<{ updated: number; failed: Track[] } | null>(null)
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
    let updated = 0
    const failedTracks: Track[] = []

    for (let i = 0; i < tracksNeedingBeatgrid.length; i++) {
      if (beatCancelRef.current) break
      const track = tracksNeedingBeatgrid[i]
      setBeatProgress({ current: i + 1, total: tracksNeedingBeatgrid.length })
      setBeatCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        await window.api.library.analyzeBeats(track.id)
        updated++
      } catch {
        failedTracks.push(track)
      }
    }

    setBeatPhase('done')
    setBeatResult({ updated, failed: failedTracks })
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
  const [analysisResult, setAnalysisResult] = useState<{ updated: number; skipped: number; failed: Track[] } | null>(null)
  const cancelRef = useRef(false)

  const tracksNeedingAnalysis = tracks.filter((t) => !t.bpm || !t.key || t.energy == null || t.danceability == null)
  const tracksNeedingBpm         = tracks.filter((t) => !t.bpm).length
  const tracksNeedingKey         = tracks.filter((t) => !t.key).length
  const tracksNeedingEnergy      = tracks.filter((t) => t.energy == null).length
  const tracksNeedingDanceability = tracks.filter((t) => t.danceability == null).length

  const startAnalysis = useCallback(async (): Promise<void> => {
    if (!tracksNeedingAnalysis.length) return
    cancelRef.current = false
    setAnalysisResult(null)
    setAnalysisProgress({ current: 0, total: tracksNeedingAnalysis.length })

    let updated = 0, skipped = 0
    const failedAnalysis: Track[] = []

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
      return !current.bpm || !current.key || current.energy == null || current.danceability == null
    })

    if (stillNeeding.length === 0) {
      setAnalysisPhase('done')
      setAnalysisResult({ updated, skipped, failed: failedAnalysis })
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

        const newBpm         = (!track.bpm && result.bpm)                              ? result.bpm         : track.bpm
        const newKey         = (!track.key && result.key)                              ? result.key         : track.key
        const newEnergy      = (track.energy == null && result.energy != null)         ? result.energy      : track.energy
        const newDanceability = (track.danceability == null && result.danceability != null) ? result.danceability : track.danceability
        const newBeatgrid = (track.beatgrid.length === 0 && newBpm && result.offsetMs != null)
          ? generateBeatgrid(newBpm, result.offsetMs, audioBuffer.duration * 1000)
          : track.beatgrid
        const newCuePoints = (track.cuePoints.length === 0 && result.suggestedCues.length > 0)
          ? result.suggestedCues.map((c, i) => ({
              index: i, type: 'hotcue' as const,
              positionMs: c.positionMs, color: c.color, label: c.label,
            }))
          : track.cuePoints

        if (newBpm !== track.bpm || newKey !== track.key || newEnergy !== track.energy || newDanceability !== track.danceability || newBeatgrid !== track.beatgrid || newCuePoints !== track.cuePoints) {
          await updateTrack({ id: track.id, bpm: newBpm, key: newKey, energy: newEnergy, danceability: newDanceability, beatgrid: newBeatgrid, cuePoints: newCuePoints })
          updated++
        } else {
          skipped++
        }
      } catch {
        failedAnalysis.push(track)
      }
    }

    await ctx.close()
    setAnalysisPhase('done')
    setAnalysisResult({ updated, skipped, failed: failedAnalysis })
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

  const locateTrack = async (track: Track): Promise<void> => {
    const p = await window.api.settings.choosePath(`Locate: ${track.title || track.filePath}`, false)
    if (!p) return
    await updateTrack({ id: track.id, filePath: p })
    setMissing((prev) => prev?.filter((t) => t.id !== track.id) ?? null)
  }

  const [locating, setLocating] = useState(false)
  const [locateResult, setLocateResult] = useState<{ found: number; total: number } | null>(null)

  const autoLocate = async (): Promise<void> => {
    if (!missing?.length) return
    setLocating(true)
    setLocateResult(null)
    const results = await window.api.library.autoLocateMissing()
    setLocating(false)
    if (!results.length) { setLocateResult({ found: 0, total: missing.length }); return }
    const foundIds = new Set(results.map((r) => r.trackId))
    await useLibraryStore.getState().loadLibrary()
    setMissing((prev) => prev?.filter((t) => !foundIds.has(t.id)) ?? null)
    setLocateResult({ found: results.length, total: missing.length })
  }

  const totalDupeCount = dupes?.reduce((s, g) => s + g.length, 0) ?? 0

  // ── Auto-cue batch ────────────────────────────────────────────────────────
  type CuePhase = 'idle' | 'running' | 'done'
  const [cuePhase, setCuePhase] = useState<CuePhase>('idle')
  const [cueProgress, setCueProgress] = useState({ current: 0, total: 0 })
  const [cueCurrentTitle, setCueCurrentTitle] = useState('')
  const [cueResult, setCueResult] = useState<{ generated: number; failed: Track[] } | null>(null)
  const cueCancelRef = useRef(false)

  const tracksNeedingCues = tracks.filter((t) => t.cuePoints.length === 0 && t.bpm != null)

  const startAutoCue = useCallback(async (): Promise<void> => {
    if (!tracksNeedingCues.length) return
    cueCancelRef.current = false
    setCueResult(null)
    setCuePhase('running')
    setCueProgress({ current: 0, total: tracksNeedingCues.length })

    let generated = 0
    const failedTracks: Track[] = []

    for (let i = 0; i < tracksNeedingCues.length; i++) {
      if (cueCancelRef.current) break
      const track = tracksNeedingCues[i]
      setCueProgress({ current: i + 1, total: tracksNeedingCues.length })
      setCueCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const cues = await generateCuesForFile(track.filePath)
        if (cues.length > 0) {
          await updateTrack({ id: track.id, cuePoints: cues })
          generated++
        }
      } catch {
        failedTracks.push(track)
      }
    }

    setCuePhase('done')
    setCueResult({ generated, failed: failedTracks })
    if (generated > 0) await useLibraryStore.getState().loadLibrary()
  }, [tracksNeedingCues, updateTrack])

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
          <AnalysisStatCard
            label="missing energy"
            value={tracksNeedingEnergy.toLocaleString()}
          />
          <AnalysisStatCard
            label="missing danceability"
            value={tracksNeedingDanceability.toLocaleString()}
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
          <div className="space-y-3">
            <div className="flex items-center gap-4 font-mono text-[10px]">
              <span className="text-green-600 dark:text-green-400">
                ✓ {analysisResult.updated} updated
              </span>
              {analysisResult.skipped > 0 && (
                <span className="text-muted">{analysisResult.skipped} unchanged</span>
              )}
              {analysisResult.failed.length > 0 && (
                <span className="text-red-500">{analysisResult.failed.length} failed</span>
              )}
            </div>
            {analysisResult.failed.length > 0 && (
              <div className="space-y-1">
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
                  failed tracks — could not be decoded or analysed
                </p>
                <div className="space-y-px max-h-40 overflow-y-auto">
                  {analysisResult.failed.map((t) => (
                    <div key={t.id} className="flex items-center gap-3 px-3 py-1.5 bg-red-500/5 border border-red-500/15 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-[10px] text-ink truncate">
                          {t.title || t.filePath.split('/').pop() || t.id}
                        </p>
                        <p className="font-mono text-[8.5px] text-muted truncate">{t.artist || t.filePath}</p>
                      </div>
                      <button
                        onClick={() => window.api.settings.openInFinder(t.filePath)}
                        className="shrink-0 font-mono text-[9px] text-muted/60 hover:text-accent transition-colors"
                        title="Reveal in Finder"
                      >↗</button>
                    </div>
                  ))}
                </div>
              </div>
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
          <div className="space-y-3">
            <div className="flex items-center gap-4 font-mono text-[10px]">
              <span className="text-green-600 dark:text-green-400">
                ✓ {beatResult.updated} analysed
              </span>
              {beatResult.failed.length > 0 && (
                <span className="text-red-500">{beatResult.failed.length} failed</span>
              )}
              {beatCancelRef.current && (
                <span className="text-muted">· cancelled</span>
              )}
            </div>
            {beatResult.failed.length > 0 && (
              <div className="space-y-1">
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">
                  failed tracks — likely corrupt files or unsupported formats
                </p>
                <div className="space-y-px max-h-48 overflow-y-auto">
                  {beatResult.failed.map((t) => (
                    <div key={t.id} className="flex items-center gap-3 px-3 py-1.5 bg-red-500/5 border border-red-500/15 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-[10px] text-ink truncate">
                          {t.title || t.filePath.split('/').pop() || t.id}
                        </p>
                        <p className="font-mono text-[8.5px] text-muted truncate">{t.artist || t.filePath}</p>
                      </div>
                      <button
                        onClick={() => window.api.settings.openInFinder(t.filePath)}
                        className="shrink-0 font-mono text-[9px] text-muted/60 hover:text-accent transition-colors"
                        title="Reveal in Finder"
                      >↗</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="font-mono text-[10px] text-ink-soft">
                  <span className="text-red-500 font-bold">{missing.length}</span> missing file{missing.length !== 1 ? 's' : ''}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={autoLocate}
                    disabled={locating}
                    className="px-3 py-1.5 bg-accent/10 hover:bg-accent/20 text-accent font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-accent/25 transition-colors disabled:opacity-40"
                  >
                    {locating ? 'searching…' : 'auto-locate'}
                  </button>
                  <button
                    onClick={deleteAllMissing}
                    className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors"
                  >
                    remove all
                  </button>
                </div>
              </div>
              {locateResult && (
                <p className={`font-mono text-[10px] ${locateResult.found > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted'}`}>
                  {locateResult.found > 0
                    ? `✓ relocated ${locateResult.found} of ${locateResult.total} files`
                    : 'no matching files found in that folder'}
                </p>
              )}
              <div className="space-y-1">
                {missing.map((track) => (
                  <div key={track.id} className="flex items-center gap-3 py-2 px-3 bg-red-600/5 border border-red-600/15 rounded">
                    <div className="flex-1 min-w-0">
                      <p className="font-sans text-xs text-ink truncate">{track.title || 'Unknown'}</p>
                      <p className="font-mono text-[9px] text-muted truncate">{track.filePath}</p>
                    </div>
                    <button
                      onClick={() => locateTrack(track)}
                      className="shrink-0 text-accent/70 hover:text-accent font-mono text-[10px] transition-colors"
                    >
                      locate
                    </button>
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

      {/* ── Play History ──────────────────────────────────────────────────── */}
      <div className="border-t border-border/20" />
      <PlayHistorySection tracks={tracks} />

      <div className="border-t border-border/20" />
      <AutoGroupSection tracks={tracks} />

      {/* ── Auto-Cue Generation ───────────────────────────────────────────── */}
      <div className="border-t border-border/20" />
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
              <span className="text-accent mr-1.5">08</span>auto-cue generation
            </h2>
            <p className="font-mono text-[10px] text-muted mt-0.5">
              analyses energy curve to place mix-in, drop, breakdown and outro markers
            </p>
          </div>
          <div className="flex items-center gap-2">
            {cuePhase === 'running' && (
              <button
                onClick={() => { cueCancelRef.current = true }}
                className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors"
              >cancel</button>
            )}
            <button
              onClick={startAutoCue}
              disabled={cuePhase === 'running' || tracksNeedingCues.length === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors"
            >
              {cuePhase === 'running' ? 'generating…' : cuePhase === 'done' ? 're-run' : 'generate cues'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <AnalysisStatCard
            label="need cue points"
            value={tracksNeedingCues.length.toLocaleString()}
            sub={`of ${tracks.length.toLocaleString()} tracks`}
            accent={tracksNeedingCues.length > 0}
          />
          <AnalysisStatCard
            label="have cue points"
            value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()}
          />
          <AnalysisStatCard
            label="cues per track"
            value={tracks.length > 0
              ? (tracks.reduce((s, t) => s + t.cuePoints.length, 0) / tracks.filter(t => t.cuePoints.length > 0).length || 0).toFixed(1)
              : '—'}
            sub="avg (tracks with cues)"
          />
        </div>

        <div className="bg-ink/[0.03] border border-border/20 rounded px-4 py-3 space-y-1">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">what gets placed</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1">
            {[
              { color: '#3CA86A', label: 'Mix In', desc: 'first energy rise above intro' },
              { color: '#D86A4A', label: 'Drop',   desc: 'global energy peak' },
              { color: '#3CA8C0', label: 'Break',  desc: 'post-drop energy dip' },
              { color: '#A855C8', label: 'Outro',  desc: 'energy falls and stays low' },
            ].map(({ color, label, desc }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                <span className="font-mono text-[9px] font-bold text-ink w-12 shrink-0">{label}</span>
                <span className="font-mono text-[9px] text-muted">{desc}</span>
              </div>
            ))}
          </div>
        </div>

        {cuePhase === 'running' && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] text-accent uppercase tracking-[0.1em]">analysing tracks</span>
              <span className="font-mono text-[10px] text-muted tabular-nums">
                {cueProgress.current} / {cueProgress.total}
              </span>
            </div>
            <div className="h-1 bg-border/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all"
                style={{ width: `${cueProgress.total ? (cueProgress.current / cueProgress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="font-mono text-[9px] text-muted truncate">{cueCurrentTitle}</p>
          </div>
        )}

        {cuePhase === 'done' && cueResult && (
          <div className="space-y-3">
            <div className="flex items-center gap-4 font-mono text-[10px]">
              <span className="text-green-600 dark:text-green-400">
                ✓ {cueResult.generated} track{cueResult.generated !== 1 ? 's' : ''} got cues
              </span>
              {cueResult.failed.length > 0 && (
                <span className="text-red-500">{cueResult.failed.length} failed</span>
              )}
              {cueCancelRef.current && <span className="text-muted">· cancelled</span>}
            </div>
            {cueResult.failed.length > 0 && (
              <div className="space-y-px max-h-40 overflow-y-auto">
                {cueResult.failed.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-1.5 bg-red-500/5 border border-red-500/15 rounded">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-[10px] text-ink truncate">{t.title || t.filePath.split('/').pop() || t.id}</p>
                      <p className="font-mono text-[8.5px] text-muted truncate">{t.artist || t.filePath}</p>
                    </div>
                    <button
                      onClick={() => window.api.settings.openInFinder(t.filePath)}
                      className="shrink-0 font-mono text-[9px] text-muted/60 hover:text-accent transition-colors"
                      title="Reveal in Finder"
                    >↗</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tracksNeedingCues.length === 0 && cuePhase === 'idle' && tracks.length > 0 && (
          <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> all {tracks.filter(t => t.cuePoints.length > 0).length.toLocaleString()} analysed tracks have cue points
          </p>
        )}
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

function PlayHistorySection({ tracks }: { tracks: Track[] }): JSX.Element {
  const totalPlays   = tracks.reduce((s, t) => s + t.playCount, 0)
  const neverPlayed  = tracks.filter((t) => t.playCount === 0).length
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const recentCount  = tracks.filter((t) => t.lastPlayedAt && t.lastPlayedAt >= sevenDaysAgo).length

  const topTracks = [...tracks]
    .filter((t) => t.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 10)

  const genreCounts = new Map<string, number>()
  for (const t of tracks) {
    if (t.genre && t.playCount > 0) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + t.playCount)
  }
  const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
        <span className="text-accent mr-1.5">07</span>play history
      </h2>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="total plays"   value={totalPlays.toLocaleString()} />
        <StatCard label="played last 7d" value={recentCount.toLocaleString()} sub={pct(recentCount, tracks.length)} />
        <StatCard label="never played"  value={neverPlayed.toLocaleString()} sub={pct(neverPlayed, tracks.length)} />
      </div>

      {topTracks.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">most played</p>
          <div className="space-y-1">
            {topTracks.map((t, i) => (
              <div key={t.id} className="flex items-center gap-3 py-1.5 px-3 bg-ink/[0.03] border border-border/20 rounded">
                <span className="font-mono text-[9px] text-muted/50 tabular-nums w-4 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[10px] text-ink truncate block">{t.title || '—'}</span>
                  <span className="font-mono text-[9px] text-muted truncate block">{t.artist}</span>
                </div>
                <span className="font-mono text-[10px] font-bold text-accent tabular-nums shrink-0">
                  {t.playCount}×
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topGenres.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">plays by genre</p>
          <div className="space-y-1.5">
            {topGenres.map(([genre, count]) => {
              const maxCount = topGenres[0][1]
              return (
                <div key={genre} className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-ink-soft w-32 truncate shrink-0">{genre}</span>
                  <div className="flex-1 h-1.5 bg-ink/[0.07] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent/60 rounded-full transition-all"
                      style={{ width: `${(count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="font-mono text-[9px] text-muted tabular-nums w-8 text-right shrink-0">{count}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {totalPlays === 0 && (
        <p className="font-mono text-[10px] text-muted/50 italic">No plays recorded yet. Tracks you play are counted automatically.</p>
      )}
    </section>
  )
}

// ── Auto Group section ────────────────────────────────────────────────────────

function AutoGroupSection({ tracks }: { tracks: Track[] }): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)

  const [epsilon,  setEpsilon]  = useState(0.15)
  const [minPts,   setMinPts]   = useState(0)          // 0 = auto
  const [running,  setRunning]  = useState(false)
  const [preview,  setPreview]  = useState<{ name: string; count: number; keyLabel: string }[] | null>(null)
  const [noiseCount, setNoiseCount] = useState(0)
  const [saved,    setSaved]    = useState(false)

  const effectiveMinPts = minPts > 0 ? minPts : Math.max(5, Math.floor(tracks.length / 100))

  const run = useCallback((): void => {
    setRunning(true)
    setSaved(false)
    // yield to render before blocking
    setTimeout(() => {
      const { clusters, noise } = dbscan(tracks, epsilon, effectiveMinPts)
      setPreview(clusters.map((c) => ({
        name:     clusterName(c),
        count:    c.length,
        keyLabel: clusterKeyLabel(c),
      })))
      setNoiseCount(noise.length)
      setRunning(false)
    }, 20)
  }, [tracks, epsilon, effectiveMinPts])

  const save = useCallback(async (): Promise<void> => {
    if (!preview) return
    setRunning(true)
    // Recompute with full track data to get trackIds
    const { clusters } = dbscan(tracks, epsilon, effectiveMinPts)
    const clusterData = clusters.map((c) => ({
      name:     clusterName(c),
      trackIds: c.map((t) => t.id),
    }))
    await window.api.library.runAutoGroup(clusterData)
    await loadLibrary()
    setSaved(true)
    setRunning(false)
  }, [preview, tracks, epsilon, effectiveMinPts, loadLibrary])

  const eligible = tracks.filter((t) => t.bpm != null).length

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
        <span className="text-accent mr-1.5">08</span>auto group
      </h2>
      <p className="font-mono text-[9.5px] text-muted/80 leading-relaxed">
        Clusters the library by BPM, key, and energy using DBSCAN. Creates a set of
        non-destructive playlists under <span className="text-ink">Auto Groups</span> in the sidebar.
        Re-running replaces the previous groups.
      </p>

      {/* Parameters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">ε</label>
          <input
            type="range" min="0.05" max="0.40" step="0.01"
            value={epsilon}
            onChange={(e) => { setEpsilon(parseFloat(e.target.value)); setPreview(null) }}
            className="w-28 accent-accent"
          />
          <span className="font-mono text-[10px] text-ink tabular-nums w-8">{epsilon.toFixed(2)}</span>
          <span className="font-mono text-[9px] text-muted/60">
            {epsilon < 0.10 ? 'tight' : epsilon < 0.18 ? 'balanced' : 'broad'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">min tracks</label>
          <input
            type="number" min="2" max="50"
            value={minPts || ''}
            placeholder={String(effectiveMinPts)}
            onChange={(e) => { setMinPts(parseInt(e.target.value) || 0); setPreview(null) }}
            className="w-16 bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent"
          />
        </div>
        <span className="font-mono text-[9px] text-muted/50">
          {eligible.toLocaleString()} of {tracks.length.toLocaleString()} tracks eligible
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={run}
          disabled={running || tracks.length === 0}
          className="px-4 py-2 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
        >
          {running ? 'running…' : 'preview groups'}
        </button>
        {preview && !saved && (
          <button
            onClick={save}
            disabled={running || preview.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-paper rounded font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40"
          >
            save {preview.length} groups to library
          </button>
        )}
        {saved && (
          <span className="font-mono text-[10px] text-green-600 dark:text-green-400">
            ✓ Groups saved — check Auto Groups in the sidebar
          </span>
        )}
      </div>

      {/* Preview results */}
      {preview && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] text-muted uppercase tracking-[0.12em]">
            {preview.length} groups · {noiseCount} ungrouped
          </p>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {preview.map((g, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 px-3 bg-ink/[0.03] border border-border/25 rounded">
                <span className="font-mono text-[9px] text-muted/50 tabular-nums w-5 text-right shrink-0">{i + 1}</span>
                <span className="flex-1 font-mono text-[10px] text-ink truncate">{g.name}</span>
                {g.keyLabel && (
                  <span className="font-mono text-[9px] text-muted shrink-0">{g.keyLabel}</span>
                )}
                <span className="font-mono text-[10px] font-bold text-accent tabular-nums shrink-0">{g.count}</span>
              </div>
            ))}
          </div>
          {preview.length === 0 && (
            <p className="font-mono text-[9.5px] text-muted/60 italic">
              No groups found — try raising ε or lowering min tracks
            </p>
          )}
        </div>
      )}
    </section>
  )
}
