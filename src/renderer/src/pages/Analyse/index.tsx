/**
 * Analyse — automated batch processing tools.
 * 01 · BPM + Key + Energy analysis
 * 02 · Beat grid analysis (Beat This! ONNX)
 * 03 · Auto-cue generation
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useAnalysisStore } from '../../store/analysisStore'
import { analyzeAudio, generateCuesForFile, computeRmsGainDb, downbeatsForTrack } from '../../lib/analyzer'
import { generateBeatgrid } from '../../lib/compatibility'
import { getQuantiser, initQuantiser } from '../../lib/quantiser'
import { batchInferGenres } from '../../lib/genreInference'
import { PageHeader } from '../../components/PageHeader'
import { tabClass, btnPrimary } from '../../lib/ui'
import type { Track } from '@shared/types'

const ANALYSE_TOOLS = [
  { id: 'meta', label: 'BPM · Key · Energy' },
  { id: 'grid', label: 'Beat grid' },
  { id: 'cues', label: 'Auto-cue' },
  { id: 'genre', label: 'Genre' },
  { id: 'gain', label: 'Auto-gain' }
] as const
type AnalyseTool = (typeof ANALYSE_TOOLS)[number]['id']

// ── Shared helpers ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: boolean
}): JSX.Element {
  return (
    <div className="bg-ink/[0.03] border border-border/25 rounded p-3 space-y-0.5">
      <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className={`font-mono text-lg font-bold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</p>
      {sub && <p className="font-mono text-[12px] text-muted/70">{sub}</p>}
    </div>
  )
}

function ProgressBar({ current, total, label, title, startTime }: {
  current: number; total: number; label: string; title: string; startTime?: number
}): JSX.Element {
  const eta = (() => {
    if (!startTime || current < 2 || !total) return null
    const elapsed = (Date.now() - startTime) / 1000
    const rate = current / elapsed               // tracks per second
    const remaining = (total - current) / rate   // seconds remaining
    if (remaining < 60) return `~${Math.round(remaining)}s`
    return `~${Math.round(remaining / 60)}m`
  })()

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[13px] text-accent uppercase tracking-[0.1em]">{label}</span>
        <div className="flex items-baseline gap-2">
          {eta && <span className="font-mono text-[12px] text-muted/50">{eta} remaining</span>}
          <span className="font-mono text-[13px] text-muted tabular-nums">{current} / {total}</span>
        </div>
      </div>
      <div className="h-1 bg-border/30 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all"
          style={{ width: `${total ? (current / total) * 100 : 0}%` }}
        />
      </div>
      <p className="font-mono text-[12px] text-muted truncate">{title}</p>
    </div>
  )
}

function FailedList({ tracks: failed }: { tracks: Track[] }): JSX.Element {
  return (
    <div className="space-y-px max-h-48 overflow-y-auto">
      {failed.map((t) => (
        <div key={t.id} className="flex items-center gap-3 px-3 py-1.5 bg-red-500/5 border border-red-500/15 rounded">
          <div className="flex-1 min-w-0">
            <p className="font-mono text-[13px] text-ink truncate">{t.title || t.filePath.split('/').pop() || t.id}</p>
            <p className="font-mono text-[11px] text-muted truncate">{t.artist || t.filePath}</p>
          </div>
          <button
            onClick={() => window.api.settings.openInFinder(t.filePath)}
            className="shrink-0 font-mono text-[12px] text-muted/60 hover:text-accent transition-colors"
            title="Reveal in Finder"
          >↗</button>
        </div>
      ))}
    </div>
  )
}

// ── BPM + Key Analysis ────────────────────────────────────────────────────────

type AnalysisPhase = 'idle' | 'tags' | 'audio' | 'done'

function BpmKeySection(): JSX.Element {
  const { tracks, updateTrack } = useLibraryStore()
  const [phase, setPhase]   = useState<AnalysisPhase>('idle')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [currentTitle, setCurrentTitle] = useState('')
  const [result, setResult] = useState<{ updated: number; skipped: number; failed: Track[]; updatedIds: string[] } | null>(null)
  const [writingTags, setWritingTags] = useState(false)
  const cancelRef = useRef(false)
  const startTimeRef = useRef<number>(0)

  const needingAnalysis    = tracks.filter((t) => !t.bpm || !t.key || t.energy == null || t.danceability == null)
  const needingBpm         = tracks.filter((t) => !t.bpm).length
  const needingKey         = tracks.filter((t) => !t.key).length
  const needingEnergy      = tracks.filter((t) => t.energy == null).length
  const needingDanceability = tracks.filter((t) => t.danceability == null).length

  const start = useCallback(async () => {
    if (!needingAnalysis.length) return
    cancelRef.current = false
    startTimeRef.current = Date.now()
    setResult(null)
    setProgress({ current: 0, total: needingAnalysis.length })
    let updated = 0, skipped = 0
    const failed: Track[] = []
    const updatedIds: string[] = []

    // Phase 1: read embedded tags (fast)
    setPhase('tags')
    for (let i = 0; i < needingAnalysis.length; i++) {
      if (cancelRef.current) { setPhase('idle'); return }
      const track = needingAnalysis[i]
      setProgress({ current: i + 1, total: needingAnalysis.length })
      setCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const tags = await window.api.audio.readTags(track.filePath)
        if (tags) {
          const newBpm = (!track.bpm && tags.bpm) ? tags.bpm : track.bpm
          const newKey = (!track.key && tags.key) ? tags.key : track.key
          if (newBpm !== track.bpm || newKey !== track.key) {
            await updateTrack({ id: track.id, bpm: newBpm, key: newKey })
            updated++; updatedIds.push(track.id)
          }
        }
      } catch { /* fall through to Phase 2 */ }
    }

    // Re-check which tracks still need analysis
    const stillNeeding = needingAnalysis.filter((t) => {
      const current = tracks.find((x) => x.id === t.id) ?? t
      return !current.bpm || !current.key || current.energy == null || current.danceability == null
    })
    if (!stillNeeding.length) {
      setPhase('done')
      setResult({ updated, skipped, failed, updatedIds })
      return
    }

    // Phase 2: audio decode + analysis (slow)
    setPhase('audio')
    setProgress({ current: 0, total: stillNeeding.length })
    const ctx = new AudioContext()
    for (let i = 0; i < stillNeeding.length; i++) {
      if (cancelRef.current) break
      const track = stillNeeding[i]
      setProgress({ current: i + 1, total: stillNeeding.length })
      setCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const ab = await window.api.audio.readFile(track.filePath)
        const buf = await ctx.decodeAudioData(ab)
        const r   = await analyzeAudio(buf, downbeatsForTrack(track))
        const newBpm  = (!track.bpm && r.bpm) ? r.bpm : track.bpm
        const newKey  = (!track.key && r.key) ? r.key : track.key
        const newNrg  = (track.energy == null && r.energy != null) ? r.energy : track.energy
        const newDnce = (track.danceability == null && r.danceability != null) ? r.danceability : track.danceability
        const newMood = (track.mood == null && r.mood != null) ? r.mood : track.mood
        const newGrid = (track.beatgrid.length === 0 && newBpm && r.offsetMs != null)
          ? generateBeatgrid(newBpm, r.offsetMs, buf.duration * 1000) : track.beatgrid
        const newCues = (track.cuePoints.length === 0 && r.suggestedCues.length > 0)
          ? r.suggestedCues.map((c, idx) => ({ index: idx, type: 'hotcue' as const, positionMs: c.positionMs, color: c.color, label: c.label, confidence: c.confidence }))
          : track.cuePoints
        if (newBpm !== track.bpm || newKey !== track.key || newNrg !== track.energy || newDnce !== track.danceability || newMood !== track.mood || newGrid !== track.beatgrid || newCues !== track.cuePoints) {
          await updateTrack({ id: track.id, bpm: newBpm, key: newKey, energy: newNrg, danceability: newDnce, mood: newMood, beatgrid: newGrid, cuePoints: newCues })
          updated++; updatedIds.push(track.id)
        } else skipped++
      } catch { failed.push(track) }
    }
    await ctx.close()
    setPhase('done')
    setResult({ updated, skipped, failed, updatedIds })
  }, [needingAnalysis, tracks, updateTrack])

  const running = phase === 'tags' || phase === 'audio'

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">bpm + key + energy
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">reads embedded tags first · falls back to audio analysis</p>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <button onClick={() => { cancelRef.current = true }}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">
              cancel
            </button>
          )}
          <button onClick={start}
            disabled={running || needingAnalysis.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
            {phase === 'tags' ? 'reading tags…' : phase === 'audio' ? 'analysing audio…' : phase === 'done' ? 're-analyse' : 'analyse library'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="need analysis"       value={needingAnalysis.length.toLocaleString()} sub={`of ${tracks.length.toLocaleString()} tracks`} accent={needingAnalysis.length > 0} />
        <StatCard label="missing bpm"         value={needingBpm.toLocaleString()} />
        <StatCard label="missing key"         value={needingKey.toLocaleString()} />
        <StatCard label="missing energy"      value={needingEnergy.toLocaleString()} />
        <StatCard label="missing danceability" value={needingDanceability.toLocaleString()} />
      </div>

      {running && <ProgressBar current={progress.current} total={progress.total}
        label={phase === 'tags' ? 'phase 1 · reading tags' : 'phase 2 · audio analysis'}
        title={currentTitle}
        startTime={startTimeRef.current} />}

      {phase === 'done' && result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 font-mono text-[13px] flex-wrap">
            <span className="text-green-600 dark:text-green-400">✓ {result.updated} updated</span>
            {result.skipped > 0 && <span className="text-muted">{result.skipped} unchanged</span>}
            {result.failed.length > 0 && <span className="text-red-500">{result.failed.length} failed</span>}
            {result.updatedIds.length > 0 && (
              <button
                onClick={async () => {
                  setWritingTags(true)
                  for (const id of result.updatedIds) {
                    try { await window.api.library.writeTagsToFile(id) } catch { /* skip unwritable */ }
                  }
                  setWritingTags(false)
                }}
                disabled={writingTags}
                className="font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-accent border border-border/35 hover:border-accent/30 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
              >
                {writingTags ? 'writing…' : `write ${result.updatedIds.length} to file tags`}
              </button>
            )}
          </div>
          {result.failed.length > 0 && <FailedList tracks={result.failed} />}
        </div>
      )}

      {needingAnalysis.length === 0 && phase === 'idle' && tracks.length > 0 && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> all {tracks.length.toLocaleString()} tracks have bpm and key data
        </p>
      )}
    </section>
  )
}

// ── Beat Grid Analysis ────────────────────────────────────────────────────────

type BeatPhase = 'idle' | 'running' | 'done'

function BeatGridSection(): JSX.Element {
  const { tracks } = useLibraryStore()
  const [modelStatus, setModelStatus] = useState<{ available: boolean; path: string } | null>(null)
  const [phase, setPhase]             = useState<BeatPhase>('idle')
  const [progress, setProgress]       = useState({ current: 0, total: 0, trackPct: 0 })
  const [currentTitle, setCurrentTitle] = useState('')
  const [result, setResult]           = useState<{ updated: number; failed: Track[] } | null>(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    window.api.library.beatModelStatus().then((s) => {
      setModelStatus(s)
      // Initialise the singleton so `getQuantiser()` returns BeatThisQuantiser if available
      initQuantiser()
    })
  }, [])

  // Needs beat grid = no legacy markers at all, OR has markers but no v2 grid yet
  const needingGrid    = tracks.filter((t) => !t.beatgrid || t.beatgrid.length === 0)
  const needingUpgrade = tracks.filter((t) => t.beatgrid?.length > 0 && !t.analysedBeatgrid)

  const start = useCallback(async () => {
    const targets = needingGrid
    if (!targets.length || !modelStatus?.available) return
    cancelRef.current = false
    setResult(null)
    setPhase('running')
    setProgress({ current: 0, total: targets.length, trackPct: 0 })
    let updated = 0
    const failed: Track[] = []
    const q = getQuantiser()

    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break
      const track = targets[i]
      setProgress({ current: i, total: targets.length, trackPct: 0 })
      setCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        await q.analyse(track, undefined, (p) =>
          setProgress({ current: i, total: targets.length, trackPct: p })
        )
        updated++
      } catch { failed.push(track) }
    }
    setProgress((prev) => ({ ...prev, current: targets.length, trackPct: 1 }))
    setPhase('done')
    setResult({ updated, failed })
    if (updated > 0) await useLibraryStore.getState().loadLibrary()
  }, [needingGrid, modelStatus])

  /** Upgrade tracks that have legacy markers but no v2 beatgrid — no model needed */
  const upgrade = useCallback(async () => {
    if (!needingUpgrade.length) return
    setPhase('running')
    setProgress({ current: 0, total: needingUpgrade.length, trackPct: 0 })
    let updated = 0
    const { fromBeatgridMarkers: conv } = await import('../../lib/quantiser')
    for (let i = 0; i < needingUpgrade.length; i++) {
      if (cancelRef.current) break
      const track = needingUpgrade[i]
      setProgress({ current: i + 1, total: needingUpgrade.length, trackPct: 1 })
      setCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const sorted = [...track.beatgrid].sort((a, b) => a.positionMs - b.positionMs)
        const v2 = conv(sorted, 'tags')
        await window.api.library.updateTrack({ id: track.id, analysedBeatgrid: v2 })
        updated++
      } catch { /* non-fatal */ }
    }
    setPhase('done')
    setResult({ updated, failed: [] })
    if (updated > 0) await useLibraryStore.getState().loadLibrary()
  }, [needingUpgrade])

  // Combined progress: (completed tracks + current track %) / total
  const overallPct = progress.total
    ? (progress.current + progress.trackPct) / progress.total
    : 0

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">beat grid analysis
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">
            {modelStatus?.available
              ? 'beat this! onnx · per-bar tempo, downbeats, confidence'
              : 'essentia js fallback · spectral flux + dp beat tracker'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'running' && (
            <button onClick={() => { cancelRef.current = true }}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">cancel</button>
          )}
          <button onClick={start}
            disabled={phase === 'running' || modelStatus === null || needingGrid.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
            {phase === 'running' ? 'analysing…' : phase === 'done' ? 're-analyse' : 'analyse beats'}
          </button>
        </div>
      </div>

      {modelStatus && !modelStatus.available && (
        <div className="bg-ink/[0.03] border border-accent/20 rounded px-4 py-3 space-y-1.5">
          <p className="font-mono text-[13px] text-ink font-bold uppercase tracking-[0.1em]">using essentia js fallback</p>
          <p className="font-mono text-[12px] text-muted leading-relaxed">
            Spectral flux + DP beat tracker runs in-browser — no model needed. For higher accuracy, install the Beat This! ONNX model:
          </p>
          <p className="font-mono text-[11px] text-muted/70">
            Run <span className="text-ink bg-ink/10 px-1 rounded">python scripts/export-beat-this.py</span> then place <span className="text-ink">beat_this.onnx</span> at: <span className="break-all">{modelStatus.path}</span>
          </p>
        </div>
      )}

      {modelStatus !== null && (
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="need beat grid"    value={needingGrid.length.toLocaleString()} sub={`of ${tracks.length.toLocaleString()} tracks`} accent={needingGrid.length > 0} />
          <StatCard label="with beat grid"    value={(tracks.length - needingGrid.length).toLocaleString()} />
          <StatCard label="need v2 upgrade"   value={needingUpgrade.length.toLocaleString()} sub="legacy → beatgrid v2" accent={needingUpgrade.length > 0} />
          <StatCard label="model"
            value={modelStatus?.available ? 'beat this!' : 'essentia js'}
            sub={modelStatus?.available ? 'onnxruntime · cpu' : 'web worker · dp tracker'} />
        </div>
      )}

      {/* Upgrade card: shown when legacy grids exist without v2 */}
      {needingUpgrade.length > 0 && phase === 'idle' && (
        <div className="flex items-center justify-between bg-accent/5 border border-accent/20 rounded px-4 py-2.5">
          <div>
            <p className="font-mono text-[13px] text-ink font-bold">
              {needingUpgrade.length.toLocaleString()} track{needingUpgrade.length !== 1 ? 's' : ''} need beatgrid v2 upgrade
            </p>
            <p className="font-mono text-[12px] text-muted mt-0.5">converts legacy markers to beat/bar/downbeat structure · no model needed</p>
          </div>
          <button onClick={upgrade}
            className="shrink-0 ml-4 px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-accent border border-accent/40 hover:bg-accent/10 rounded transition-colors">
            upgrade
          </button>
        </div>
      )}

      {phase === 'running' && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[13px] text-accent uppercase tracking-[0.1em]">analysing beats</span>
            <span className="font-mono text-[13px] text-muted tabular-nums">
              {progress.current + 1} / {progress.total}
            </span>
          </div>
          <div className="h-1 bg-border/30 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all"
              style={{ width: `${overallPct * 100}%` }}
            />
          </div>
          <p className="font-mono text-[12px] text-muted truncate">{currentTitle}</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 font-mono text-[13px]">
            <span className="text-green-600 dark:text-green-400">✓ {result.updated} analysed</span>
            {result.failed.length > 0 && <span className="text-red-500">{result.failed.length} failed</span>}
            {cancelRef.current && <span className="text-muted">· cancelled</span>}
          </div>
          {result.failed.length > 0 && <FailedList tracks={result.failed} />}
        </div>
      )}
    </section>
  )
}

// ── Auto-Cue Generation ───────────────────────────────────────────────────────

type CuePhase = 'idle' | 'running' | 'done'

function AutoCueSection(): JSX.Element {
  const { tracks, updateTrack } = useLibraryStore()
  const [phase, setPhase]       = useState<CuePhase>('idle')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [currentTitle, setCurrentTitle] = useState('')
  const [result, setResult]     = useState<{ generated: number; failed: Track[] } | null>(null)
  const cancelRef = useRef(false)

  const needingCues = tracks.filter((t) => t.cuePoints.length === 0 && t.bpm != null)

  const start = useCallback(async () => {
    if (!needingCues.length) return
    cancelRef.current = false
    setResult(null)
    setPhase('running')
    setProgress({ current: 0, total: needingCues.length })
    let generated = 0
    const failed: Track[] = []
    for (let i = 0; i < needingCues.length; i++) {
      if (cancelRef.current) break
      const track = needingCues[i]
      setProgress({ current: i + 1, total: needingCues.length })
      setCurrentTitle(track.title || track.filePath.split('/').pop() || '')
      try {
        const cues = await generateCuesForFile(track.filePath, downbeatsForTrack(track))
        if (cues.length > 0) { await updateTrack({ id: track.id, cuePoints: cues }); generated++ }
      } catch { failed.push(track) }
    }
    setPhase('done')
    setResult({ generated, failed })
    if (generated > 0) await useLibraryStore.getState().loadLibrary()
  }, [needingCues, updateTrack])

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">auto-cue generation
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">analyses energy curve to place mix-in, drop, breakdown and outro markers</p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'running' && (
            <button onClick={() => { cancelRef.current = true }}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">cancel</button>
          )}
          <button onClick={start}
            disabled={phase === 'running' || needingCues.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
            {phase === 'running' ? 'generating…' : phase === 'done' ? 're-run' : 'generate cues'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="need cue points" value={needingCues.length.toLocaleString()} sub={`of ${tracks.length.toLocaleString()} tracks`} accent={needingCues.length > 0} />
        <StatCard label="have cue points" value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()} />
        <StatCard label="avg cues/track"
          value={(tracks.length > 0
            ? (tracks.reduce((s, t) => s + t.cuePoints.length, 0) /
               Math.max(1, tracks.filter((t) => t.cuePoints.length > 0).length)).toFixed(1)
            : '—')}
          sub="tracks with cues" />
      </div>

      {/* Cue type legend */}
      <div className="bg-ink/[0.03] border border-border/20 rounded px-4 py-3 space-y-1">
        <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">what gets placed</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1">
          {[
            { color: '#3CA86A', label: 'Mix In', desc: 'first energy rise above intro' },
            { color: '#D86A4A', label: 'Drop',   desc: 'global energy peak'            },
            { color: '#3CA8C0', label: 'Break',  desc: 'post-drop energy dip'          },
            { color: '#A855C8', label: 'Outro',  desc: 'energy falls and stays low'    },
          ].map(({ color, label, desc }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              <span className="font-mono text-[12px] font-bold text-ink w-12 shrink-0">{label}</span>
              <span className="font-mono text-[12px] text-muted">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {phase === 'running' && <ProgressBar current={progress.current} total={progress.total} label="analysing tracks" title={currentTitle} />}

      {phase === 'done' && result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 font-mono text-[13px]">
            <span className="text-green-600 dark:text-green-400">✓ {result.generated} track{result.generated !== 1 ? 's' : ''} got cues</span>
            {result.failed.length > 0 && <span className="text-red-500">{result.failed.length} failed</span>}
            {cancelRef.current && <span className="text-muted">· cancelled</span>}
          </div>
          {result.failed.length > 0 && <FailedList tracks={result.failed} />}
        </div>
      )}

      {needingCues.length === 0 && phase === 'idle' && tracks.length > 0 && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> all analysed tracks have cue points
        </p>
      )}
    </section>
  )
}

// ── Genre Suggestion ─────────────────────────────────────────────────────────

type GenrePhase = 'idle' | 'scanning' | 'review' | 'applying' | 'done'

function GenreSection(): JSX.Element {
  const { tracks, updateTrack } = useLibraryStore()
  const [phase, setPhase]   = useState<GenrePhase>('idle')
  const [suggestions, setSuggestions] = useState<
    { trackId: string; genre: string; confidence: number; reasoning: string; accepted: boolean }[]
  >([])
  const cancelRef = useRef(false)

  const noGenre = tracks.filter((t) => !t.genre)

  const scan = useCallback(() => {
    cancelRef.current = false
    setPhase('scanning')
    const raw = batchInferGenres(noGenre, 0.50)
    setSuggestions(raw.map((r) => ({ ...r, accepted: r.confidence >= 0.65 })))
    setPhase('review')
  }, [noGenre])

  const apply = useCallback(async () => {
    const toApply = suggestions.filter((s) => s.accepted)
    if (!toApply.length) { setPhase('done'); return }
    setPhase('applying')
    for (const s of toApply) {
      if (cancelRef.current) break
      await updateTrack({ id: s.trackId, genre: s.genre })
    }
    setPhase('done')
  }, [suggestions, updateTrack])

  const toggleAccept = (trackId: string) =>
    setSuggestions((prev) => prev.map((s) => s.trackId === trackId ? { ...s, accepted: !s.accepted } : s))

  const acceptedCount = suggestions.filter((s) => s.accepted).length

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">genre inference
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">
            rule-based · bpm + energy + mood + key → genre suggestion
          </p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'review' && suggestions.length > 0 && (
            <button onClick={() => { setSuggestions([]); setPhase('idle') }}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">
              cancel
            </button>
          )}
          {phase === 'review' && (
            <button onClick={apply} disabled={acceptedCount === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
              apply {acceptedCount} suggestion{acceptedCount !== 1 ? 's' : ''}
            </button>
          )}
          {phase !== 'review' && phase !== 'applying' && (
            <button onClick={scan}
              disabled={phase === 'scanning' || noGenre.length === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
              {phase === 'scanning' ? 'scanning…' : phase === 'done' ? 're-scan' : 'infer genres'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="no genre" value={noGenre.length.toLocaleString()} sub={`of ${tracks.length.toLocaleString()} tracks`} accent={noGenre.length > 0} />
        {phase !== 'idle' && <StatCard label="suggestions" value={suggestions.length.toLocaleString()} />}
        {phase !== 'idle' && <StatCard label="accepted" value={acceptedCount.toLocaleString()} accent={acceptedCount > 0} />}
      </div>

      {/* Review list */}
      {phase === 'review' && suggestions.length > 0 && (
        <div className="space-y-px max-h-72 overflow-y-auto border border-border/20 rounded">
          {/* Header */}
          <div className="flex items-center gap-3 px-3 py-1.5 bg-ink/[0.03] border-b border-border/20">
            <button onClick={() => setSuggestions((p) => p.map((s) => ({ ...s, accepted: true })))}
              className="font-mono text-[11px] text-accent hover:text-ink transition-colors">all</button>
            <button onClick={() => setSuggestions((p) => p.map((s) => ({ ...s, accepted: false })))}
              className="font-mono text-[11px] text-muted hover:text-ink transition-colors">none</button>
            <span className="flex-1" />
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted/50">genre</span>
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted/50 w-8 text-right">conf</span>
          </div>
          {suggestions.map((s) => {
            const track = tracks.find((t) => t.id === s.trackId)
            return (
              <div key={s.trackId}
                className={`flex items-center gap-3 px-3 py-1.5 border-b border-border/10 last:border-b-0 cursor-pointer transition-colors
                  ${s.accepted ? 'bg-accent/[0.04]' : 'bg-transparent hover:bg-ink/[0.02]'}`}
                onClick={() => toggleAccept(s.trackId)}
              >
                <div className={`w-3 h-3 rounded border shrink-0 flex items-center justify-center transition-colors
                  ${s.accepted ? 'bg-accent border-accent' : 'border-border/40'}`}>
                  {s.accepted && <span className="text-paper text-[11px]">✓</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[12px] text-ink truncate">{track?.title || s.trackId}</p>
                  <p className="font-mono text-[11px] text-muted/50 truncate">{s.reasoning}</p>
                </div>
                <span className="font-mono text-[12px] text-ink shrink-0">{s.genre}</span>
                <div className="w-8 shrink-0">
                  <div className="h-1 bg-border/20 rounded-full overflow-hidden">
                    <div className="h-full rounded-full"
                      style={{ width: `${s.confidence * 100}%`, background: s.confidence > 0.75 ? '#4A9B6F' : '#C9A02C' }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {phase === 'review' && suggestions.length === 0 && (
        <p className="font-mono text-[13px] text-muted">
          no confident inferences found — tracks may need BPM/energy analysis first
        </p>
      )}

      {phase === 'done' && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> genres applied
        </p>
      )}

      {noGenre.length === 0 && phase === 'idle' && tracks.length > 0 && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> all tracks have a genre
        </p>
      )}
    </section>
  )
}

// ── GainSection ───────────────────────────────────────────────────────────────

function GainSection(): JSX.Element {
  const { tracks, updateTrack } = useLibraryStore()
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, label: '' })
  const [done, setDone]         = useState(false)
  const cancelRef = useRef(false)

  const unanalysed = tracks.filter((t) => t.gainDb == null)

  const run = useCallback(async () => {
    cancelRef.current = false
    setRunning(true)
    setDone(false)
    const ctx = new AudioContext()
    const toProcess = tracks.filter((t) => t.gainDb == null)
    setProgress({ current: 0, total: toProcess.length, label: '' })

    for (let i = 0; i < toProcess.length; i++) {
      if (cancelRef.current) break
      const t = toProcess[i]
      const label = t.title || t.filePath.split('/').pop() || t.id
      setProgress({ current: i + 1, total: toProcess.length, label })
      try {
        const ab  = await window.api.audio.readFile(t.filePath)
        const buf = await ctx.decodeAudioData(ab)
        const gainDb = computeRmsGainDb(buf)
        await updateTrack({ id: t.id, gainDb })
      } catch { /* skip unreadable */ }
    }
    await ctx.close()
    setRunning(false)
    setDone(true)
    setProgress({ current: 0, total: 0, label: '' })
  }, [tracks, updateTrack])

  const analysedCount = tracks.filter((t) => t.gainDb != null).length

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">auto-gain (RMS normalisation)
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">
            measures per-track loudness · stores gain_db correction to −14 dBFS target
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <button onClick={() => { cancelRef.current = true }}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">
              cancel
            </button>
          )}
          {!running && (
            <button
              onClick={run}
              disabled={unanalysed.length === 0}
              className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors"
            >
              {done ? 're-analyse' : `analyse ${unanalysed.length} track${unanalysed.length !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="analysed" value={analysedCount.toLocaleString()} sub={`of ${tracks.length.toLocaleString()} tracks`} accent={analysedCount > 0} />
        <StatCard label="pending" value={unanalysed.length.toLocaleString()} />
      </div>

      {running && progress.total > 0 && (
        <ProgressBar
          current={progress.current}
          total={progress.total}
          label="gain analysis"
          title={progress.label}
        />
      )}

      {done && !running && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> gain_db stored · enable auto-gain in Settings → Preferences to apply on deck load
        </p>
      )}

      {unanalysed.length === 0 && !running && tracks.length > 0 && (
        <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
          <span>✓</span> all tracks have gain data
        </p>
      )}
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function AnalysePage(): JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const running = useAnalysisStore((s) => s.running)
  const [busy, setBusy] = useState(false)
  const [tool, setTool] = useState<AnalyseTool>('meta')

  // Tracks needing each step (matches the per-section targeting below).
  const needGrid = tracks.filter((t) => !t.beatgrid?.length).length
  const needMeta = tracks.filter((t) => !t.bpm || !t.key || t.energy == null).length
  const needCues = tracks.filter((t) => t.cuePoints.length === 0 && t.bpm != null).length
  const needAny  = needGrid + needMeta + needCues

  // One-click full pipeline across the library: beat grid → BPM/key/energy →
  // auto-cue, each scoped to only the tracks still missing that step (so it
  // skips work that's already done). Progress shows in the global bar.
  const runEverything = useCallback(async () => {
    setBusy(true)
    try {
      const store = useAnalysisStore.getState()
      const snap = () => useLibraryStore.getState().tracks
      const grid = snap().filter((t) => !t.beatgrid?.length).map((t) => t.id)
      if (grid.length) await store.analyseBeats(grid)
      const meta = snap().filter((t) => !t.bpm || !t.key || t.energy == null).map((t) => t.id)
      if (meta.length) await store.analyseBpm(meta)
      const cues = snap().filter((t) => t.cuePoints.length === 0 && t.bpm != null).map((t) => t.id)
      if (cues.length) await store.autoCue(cues)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        marker="→"
        title="analyse"
        subtitle="automated batch processing — bpm, keys, beat grids, cue points, gain"
        right={
          <button
            onClick={runEverything}
            disabled={busy || running || needAny === 0}
            title="Run beat grid, BPM/key/energy and auto-cue across every track that still needs it"
            className={btnPrimary}
          >
            {busy || running ? 'analysing…' : needAny === 0 ? 'all analysed' : `analyse everything (${needAny.toLocaleString()})`}
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 max-w-3xl">
        {/* Tools — one at a time instead of a long stacked scroll */}
        <div className="flex flex-wrap gap-1 border-b border-border/20 pb-2">
          {ANALYSE_TOOLS.map((t) => (
            <button key={t.id} onClick={() => setTool(t.id)} className={tabClass(tool === t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tool === 'meta' && <BpmKeySection />}
        {tool === 'grid' && <BeatGridSection />}
        {tool === 'cues' && <AutoCueSection />}
        {tool === 'genre' && <GenreSection />}
        {tool === 'gain' && <GainSection />}
      </div>
    </div>
  )
}
