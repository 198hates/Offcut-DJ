import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { DeckStore } from '../store/playerStore'
import { HOT_CUE_COLORS, HOT_CUE_LABELS, type AnalysisState } from '../store/playerStore'
import { useWaveformStore } from '../store/waveformStore'
import { generateBeatgrid } from '../lib/compatibility'
import { fromBeatgridMarkers } from '../lib/quantiser'
import { WaveformGL } from './WaveformGL'
import { OverviewWaveform } from './OverviewWaveform'
import { useArtwork } from '../hooks/useArtwork'
import type { CuePoint } from '@shared/types'

type DeckStoreHook = UseBoundStore<StoreApi<DeckStore>>

interface Props {
  useStore: DeckStoreHook
  label: 'A' | 'B'
  /** Which digit keys this deck listens to (A=no modifier, B=Alt) */
  keyMod?: 'none' | 'alt'
}

function fmt(s: number, ms = false): string {
  if (!isFinite(s) || s < 0) return ms ? '0:00.0' : '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const base = `${m}:${sec.toString().padStart(2, '0')}`
  if (!ms) return base
  return `${base}.${Math.floor((s % 1) * 10)}`
}

export function Deck({ useStore, label, keyMod = 'none' }: Props): JSX.Element {
  const waveformStyle = useWaveformStore((s) => s.style)

  const {
    currentTrack, isPlaying, currentTime, duration,
    waveformPeaks, detailPeaks, lowPeaks, midPeaks, highPeaks, isLoading, mainCueTime,
    loopStart, loopEnd, isLooping, playbackRate, analysisState,
    loadTrack, togglePlay, seek, pressCue,
    setCue, clearCue, jumpToCue, setMemoryCue,
    setLoopIn, setLoopOut, beatLoop, toggleLoop, clearLoop, setPlaybackRate,
    analyzeCurrentTrack
  } = useStore()

  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const artworkUrl  = useArtwork(currentTrack?.filePath)

  const isRight = label === 'B'

  // ── Beatgrid edit mode ────────────────────────────────────────────────────
  const [gridEditMode, setGridEditMode] = useState(false)
  const [editBpm,      setEditBpm]      = useState(128)
  const [editOffsetMs, setEditOffsetMs] = useState(0)
  const [gridAutoRunning, setGridAutoRunning] = useState(false)
  const tapTimestampsRef = useRef<number[]>([])

  // Initialise edit values when entering grid mode
  useEffect(() => {
    if (!gridEditMode || !currentTrack) return
    setEditBpm(currentTrack.bpm ?? 128)
    const offset = currentTrack.beatgrid.length > 0 ? currentTrack.beatgrid[0].positionMs : 0
    setEditOffsetMs(offset)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridEditMode, currentTrack?.id])

  // Exit grid mode when track changes or unloads
  useEffect(() => { setGridEditMode(false) }, [currentTrack?.id])

  // Live-compute a beatgrid from the local edit values (not yet saved to DB)
  const editBeatgrid = useMemo(
    () => editBpm > 0 ? generateBeatgrid(editBpm, editOffsetMs, duration * 1000) : [],
    [editBpm, editOffsetMs, duration]
  )

  const nudgeBpm = useCallback((delta: number) =>
    setEditBpm((b) => Math.round((b + delta) * 1000) / 1000), [])

  const nudgeOffset = useCallback((deltaMs: number) =>
    setEditOffsetMs((o) => {
      const beatMs = 60000 / Math.max(1, editBpm)
      return ((o + deltaMs) % beatMs + beatMs) % beatMs
    }), [editBpm])

  // Snap grid so the nearest beat lands exactly on the current playhead
  const setBeatHere = useCallback(() => {
    if (!editBpm) return
    const beatMs = 60000 / editBpm
    const posMs  = currentTime * 1000
    const rem    = posMs % beatMs
    setEditOffsetMs(rem < beatMs / 2 ? rem : rem - beatMs)
  }, [currentTime, editBpm])

  // Tap tempo
  const tapBpm = useCallback(() => {
    const now  = performance.now()
    const taps = tapTimestampsRef.current
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) taps.length = 0
    taps.push(now)
    if (taps.length >= 2) {
      const avg = taps.slice(1).reduce((s, t, i) => s + (t - taps[i]), 0) / (taps.length - 1)
      const newBpm = Math.round((60000 / avg) * 10) / 10
      if (newBpm >= 40 && newBpm <= 300) setEditBpm(newBpm)
    }
  }, [])

  // Auto-detect via Beat This! ONNX model (primary), JS onset detector (fallback)
  const autoDetectGrid = useCallback(async () => {
    if (!currentTrack || gridAutoRunning) return
    setGridAutoRunning(true)
    try {
      // ── Primary: Beat This! neural model ────────────────────────────────
      const modelStatus = await window.api.library.beatModelStatus()
      if (modelStatus.available) {
        // analyzeBeats runs the ONNX model and saves the result to the DB.
        // We extract BPM + first-beat offset from the returned Track.
        const updated = await window.api.library.analyzeBeats(currentTrack.id)
        if (updated.beatgrid.length > 0) {
          // Sort by position; first marker = beat offset anchor
          const sorted = [...updated.beatgrid].sort((a, b) => a.positionMs - b.positionMs)
          setEditBpm(updated.bpm ?? editBpm)
          setEditOffsetMs(sorted[0].positionMs)
          // Persist v2 beatgrid alongside the legacy markers
          if (!updated.analysedBeatgrid) {
            const v2 = fromBeatgridMarkers(sorted, 'beat-this')
            window.api.library.updateTrack({ id: currentTrack.id, analysedBeatgrid: v2 }).catch(() => {})
          }
          setGridAutoRunning(false)
          return
        }
      }

      // ── Fallback: JS onset detector (no model needed) ────────────────────
      const ab  = await window.api.audio.readFile(currentTrack.filePath)
      const ctx = new AudioContext()
      const buf = await ctx.decodeAudioData(ab)
      await ctx.close()

      const sr        = buf.sampleRate
      const limitSecs = Math.min(buf.duration, Math.max(4, (60000 / Math.max(60, editBpm)) * 8 / 1000))
      const limit     = Math.floor(sr * limitSecs)
      const mono      = new Float32Array(limit)
      const inv       = 1 / buf.numberOfChannels
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch)
        for (let i = 0; i < limit; i++) mono[i] += d[i] * inv
      }
      const winN    = Math.max(1, Math.floor(sr * 0.01))
      const nFrames = Math.floor(mono.length / winN)
      const rms     = new Float32Array(nFrames)
      for (let i = 0; i < nFrames; i++) {
        let e = 0
        const end = Math.min(mono.length, (i + 1) * winN)
        for (let j = i * winN; j < end; j++) e += mono[j] * mono[j]
        rms[i] = Math.sqrt(e / (end - i * winN))
      }
      const onset = new Float32Array(nFrames)
      for (let i = 1; i < nFrames; i++) onset[i] = Math.max(0, rms[i] - rms[i - 1])
      const maxO      = Math.max(...onset)
      const thr       = maxO * 0.35
      const beatMs    = 60000 / Math.max(60, editBpm)
      const searchEnd = Math.min(nFrames, Math.floor(beatMs * 2 / 10))
      for (let i = 2; i < searchEnd; i++) {
        if (onset[i] >= thr) { setEditOffsetMs((i * winN / sr) * 1000); break }
      }
    } catch { /* ignore */ }
    setGridAutoRunning(false)
  }, [currentTrack, editBpm, gridAutoRunning])

  const saveGrid = useCallback(async () => {
    if (!currentTrack || !editBpm) return
    const markers = generateBeatgrid(editBpm, editOffsetMs, duration * 1000)
    // Human-verified: force confidence = 1.0 on every beat — shading clears, KEPT stamp earned
    const keptMarkers = markers.map((m) => ({ ...m, confidence: 1.0 }))
    const analysedBeatgrid = fromBeatgridMarkers(keptMarkers, 'manual')
    await updateTrack({ id: currentTrack.id, beatgrid: markers, bpm: Math.round(editBpm * 10) / 10, analysedBeatgrid })
    setGridEditMode(false)
  }, [currentTrack, editBpm, editOffsetMs, duration, updateTrack])

  // Keyboard shortcuts — Deck A: Space / 1-8, Deck B: Alt+Space / Alt+1-8
  const handleKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const wantAlt = keyMod === 'alt'
    if (e.altKey !== wantAlt) return

    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
      // Only handle Space if it hasn't already been claimed by a focused element
      // (e.g. the Library list handles Space for 30s preview when it has focus).
      if (e.defaultPrevented) return
      e.preventDefault()
      togglePlay()
    }
    const digit = e.code.match(/^Digit([1-8])$/)?.[1]
    if (digit) {
      e.preventDefault()
      const idx = parseInt(digit) - 1
      if (e.shiftKey) setCue(idx)
      else jumpToCue(idx)
    }
  }, [togglePlay, setCue, jumpToCue, keyMod])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const tracks = useLibraryStore((s) => s.tracks)
  // Live beatgrid: prefer stored markers; fall back to a generated grid from BPM
  // so the waveform always shows a grid once a track has been analysed.
  const liveBeatgrid = useLibraryStore((s) => {
    const track = s.tracks.find((t) => t.id === currentTrack?.id) ?? currentTrack
    if (!track) return []
    if (track.beatgrid.length > 0) return track.beatgrid
    if (track.bpm && track.durationSeconds) {
      return generateBeatgrid(track.bpm, 0, track.durationSeconds * 1000)
    }
    return []
  })
  // What the waveform shows: local edit grid during editing, stored grid otherwise
  const displayBeatgrid = gridEditMode ? editBeatgrid : liveBeatgrid

  const [isDragOver, setIsDragOver] = useState(false)

  // ── Drag-to-load: drop a track from the library onto this deck ────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-crate-track-ids')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the deck entirely (not a child element)
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids'))
      const track = tracks.find((t) => t.id === ids[0])
      if (track) loadTrack(track)
    } catch { /* malformed data */ }
  }, [tracks, loadTrack])

  const hotcues = HOT_CUE_LABELS.map((lbl, i) => ({
    label: lbl, index: i,
    cue: currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === i),
    color: HOT_CUE_COLORS[i]
  }))
  const memoryCues = currentTrack?.cuePoints.filter((c) => c.type === 'memory') ?? []
  const remaining = duration - currentTime

  // Deck-zone colour helpers (always dark — not Tailwind theme aware)
  const dkRule  = 'rgba(42,36,28,0.6)'   // --deck-rule at 60%
  const dkRule2 = 'rgba(42,36,28,0.35)'  // --deck-rule at 35% (faint)

  return (
    <div
      className={`flex-1 min-w-0 flex flex-col overflow-hidden relative transition-colors ${isDragOver ? 'ring-1 ring-inset' : ''}`}
      style={isDragOver ? { background: 'rgba(216,106,74,0.08)', boxShadow: 'inset 0 0 0 1px rgba(216,106,74,0.4)' } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="text-xs font-bold px-3 py-1.5 rounded shadow-lg tracking-widest uppercase"
            style={{ background: 'rgba(216,106,74,0.9)', color: 'var(--deck-bg)' }}>
            Load to Deck {label}
          </div>
        </div>
      )}

      {/* ── Track info + BPM + time ──────────────────────────────────── */}
      <div
        className={`flex items-center gap-2 px-2 pt-1 pb-0.5 border-b ${isRight ? 'flex-row-reverse' : ''}`}
        style={{ borderColor: dkRule }}
      >
        {/* Deck label chip */}
        <div
          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-black tracking-widest select-none"
          style={{ background: 'rgba(216,106,74,0.15)', color: 'var(--deck-spot)' }}
        >
          {label}
        </div>

        {/* Album art thumbnail — 40×40, only when artwork is available */}
        {artworkUrl && (
          <div
            className="shrink-0 rounded overflow-hidden"
            style={{ width: 40, height: 40, background: 'var(--deck-rule)' }}
          >
            <img
              src={artworkUrl}
              alt=""
              className="w-full h-full object-cover"
              style={{ display: 'block' }}
            />
          </div>
        )}

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p
            className={`text-xs font-semibold truncate leading-tight overflow-hidden ${isRight ? 'text-right' : ''}`}
            style={{ color: 'var(--deck-ink)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {currentTrack?.title || (
              <span className="italic font-normal" style={{ color: 'var(--deck-mute)', opacity: 0.6 }}>
                {isRight ? 'Load a cut into deck B' : 'No track loaded'}
              </span>
            )}
          </p>
          <div className={`flex items-center gap-2 ${isRight ? 'flex-row-reverse' : ''}`}>
            <p className="text-[10px] truncate" style={{ color: 'var(--deck-mute)' }}>
              {currentTrack?.artist || ''}
              {currentTrack?.album ? ` · ${currentTrack.album}` : ''}
            </p>
            <AnalysisIndicator state={analysisState} onAnalyze={analyzeCurrentTrack} hasTrack={!!currentTrack} />
            {liveBeatgrid.length > 0 && (
              <span
                title={`Beat grid · ${liveBeatgrid.length} beats`}
                className="text-[8px] font-mono shrink-0"
                style={{ color: 'rgba(216,106,74,0.5)' }}
              >
                grid
              </span>
            )}
          </div>
        </div>

        {/* Key LED */}
        <LedReadout value={currentTrack?.key || '—'} ghost="00A"   label="key" fontSize={13} />
        {/* BPM LED */}
        <LedReadout value={currentTrack?.bpm ? currentTrack.bpm.toFixed(1) : '—.—'} ghost="000.0" label="bpm" fontSize={13} />
        {/* Time LED */}
        <LedReadout value={fmt(currentTime, true)} ghost="0:00.0" label={`-${fmt(remaining)}`} fontSize={12} />
      </div>

      {/* ── Overview waveform — dark screen ──────────────────────────── */}
      <div className="px-2 border-b" style={{ background: 'var(--deck-panel)', borderColor: dkRule2 }}>
        <OverviewWaveform
          peaks={waveformPeaks}
          lowPeaks={lowPeaks}
          midPeaks={midPeaks}
          highPeaks={highPeaks}
          waveformStyle={waveformStyle}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          beatgrid={displayBeatgrid}
          analysedBeatgrid={currentTrack?.analysedBeatgrid}
          onSeek={seek}
        />
      </div>

      {/* ── Scrolling detail waveform ─────────────────────────────────── */}
      <div className="px-2 py-1 flex flex-1 min-h-0" style={{ background: 'var(--deck-panel)' }}>
        <WaveformGL
          peaks={detailPeaks}
          lowPeaks={lowPeaks}
          midPeaks={midPeaks}
          highPeaks={highPeaks}
          waveformStyle={waveformStyle}
          duration={duration}
          currentTime={currentTime}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          beatgrid={displayBeatgrid}
          analysedBeatgrid={currentTrack?.analysedBeatgrid}
          loopStart={loopStart}
          loopEnd={loopEnd}
          isLooping={isLooping}
          onSeek={seek}
          isLoading={isLoading}
        />
      </div>

      {/* ── Beatgrid edit panel ───────────────────────────────────────── */}
      {gridEditMode && (
        <BeatgridEditPanel
          bpm={editBpm}
          offsetMs={editOffsetMs}
          markerCount={editBeatgrid.length}
          autoRunning={gridAutoRunning}
          onNudgeBpm={nudgeBpm}
          onNudgeOffset={nudgeOffset}
          onSetBeatHere={setBeatHere}
          onTap={tapBpm}
          onAuto={autoDetectGrid}
          onSave={saveGrid}
          onCancel={() => setGridEditMode(false)}
        />
      )}

      {/* ── Loop controls + pitch ─────────────────────────────────────── */}
      <div
        className={`flex items-center gap-1 px-2 py-0.5 border-t ${isRight ? 'flex-row-reverse' : ''}`}
        style={{ borderColor: dkRule2 }}
      >
        {/* Beat loop buttons */}
        {[0.5, 1, 2, 4, 8].map((bars) => (
          <button
            key={bars}
            onClick={() => beatLoop(bars)}
            disabled={!currentTrack}
            title={`${bars} bar loop`}
            className="deck-btn h-6 px-1.5 rounded text-[10px] font-bold border transition-colors disabled:opacity-25"
          >
            {bars < 1 ? '½' : bars}
          </button>
        ))}

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {/* IN / OUT / LOOP */}
        <button onClick={setLoopIn}  disabled={!currentTrack} className="deck-btn h-6 px-1.5 rounded text-[10px] font-bold border transition-colors disabled:opacity-25">IN</button>
        <button onClick={setLoopOut} disabled={!currentTrack} className="deck-btn h-6 px-1.5 rounded text-[10px] font-bold border transition-colors disabled:opacity-25">OUT</button>
        <button
          onClick={toggleLoop}
          disabled={!currentTrack || (loopStart === null && loopEnd === null)}
          className={`h-6 px-2 rounded text-[10px] font-bold border transition-colors disabled:opacity-25 ${isLooping ? 'deck-btn-active' : 'deck-btn'}`}
        >
          LOOP
        </button>
        <button
          onClick={clearLoop}
          disabled={!currentTrack || (loopStart === null)}
          className="deck-btn h-6 px-1.5 rounded text-[10px] border transition-colors disabled:opacity-25"
          title="Clear loop"
        >✕</button>

        <div className="flex-1" />

        {/* Beatgrid edit toggle */}
        <button
          onClick={() => setGridEditMode((v) => !v)}
          disabled={!currentTrack}
          title="Edit beatgrid"
          className={`h-6 px-2 rounded text-[10px] font-bold border transition-colors disabled:opacity-25 ${gridEditMode ? 'deck-btn-active' : 'deck-btn'}`}
        >
          GRID
        </button>

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {/* Pitch */}
        <div className={`flex items-center gap-1 ${isRight ? 'flex-row-reverse' : ''}`}>
          <span className="text-[9px] tabular-nums w-9 text-center" style={{ color: 'var(--deck-mute)' }}>
            {playbackRate === 1 ? '±0%' : `${playbackRate > 1 ? '+' : ''}${((playbackRate - 1) * 100).toFixed(1)}%`}
          </span>
          <input
            type="range" min={0.92} max={1.08} step={0.001}
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
            onDoubleClick={() => setPlaybackRate(1.0)}
            disabled={!currentTrack}
            className="w-16 h-1 cursor-pointer disabled:opacity-25"
            style={{ accentColor: 'var(--deck-spot)' }}
            title="Pitch/tempo — double-click to reset"
          />
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--deck-mute)' }}>Pitch</span>
        </div>
      </div>

      {/* ── Transport + hotcue pads ───────────────────────────────────── */}
      <div
        className={`flex items-center gap-1 px-2 pb-1.5 pt-0.5 flex-wrap border-t ${isRight ? 'flex-row-reverse' : ''}`}
        style={{ borderColor: dkRule2 }}
      >
        <button
          onClick={pressCue}
          disabled={!currentTrack}
          className="deck-btn h-8 px-2.5 rounded text-[10px] font-black tracking-widest border transition-colors disabled:opacity-25"
        >
          CUE
        </button>
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="h-8 w-10 rounded flex items-center justify-center transition-colors disabled:opacity-25 text-xs font-bold"
          style={{
            background: isPlaying ? 'rgba(216,106,74,0.85)' : 'var(--deck-spot)',
            color: 'var(--deck-bg)'
          }}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <div className="w-px h-5 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        {hotcues.map(({ label: lbl, index, cue, color }) => (
          <HotCuePad
            key={index}
            label={lbl}
            index={index}
            cue={cue}
            color={color}
            disabled={!currentTrack}
            onPress={() => cue ? jumpToCue(index) : setCue(index)}
            onSet={() => setCue(index)}
            onClear={() => clearCue(index)}
          />
        ))}

        <div className="w-px h-5 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          className="h-8 px-2 rounded text-[10px] font-bold border transition-colors disabled:opacity-25"
          style={{ borderColor: 'rgba(245,158,11,0.3)', color: 'rgba(245,158,11,0.7)' }}
        >
          MEM
        </button>

        {memoryCues.map((c, i) => (
          <button
            key={i}
            onClick={() => seek(c.positionMs / 1000)}
            className="h-8 px-2 rounded text-[10px] font-mono border transition-colors tabular-nums"
            style={{ borderColor: 'rgba(245,158,11,0.2)', color: 'rgba(245,158,11,0.5)' }}
          >
            {fmt(c.positionMs / 1000)}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── LedReadout ────────────────────────────────────────────────────────────────

function LedReadout({ value, ghost, label, fontSize = 14 }: {
  value: string; ghost: string; label: string; fontSize?: number
}): JSX.Element {
  return (
    <div className="led-readout shrink-0 text-right">
      <div className="led-readout-ghost" style={{ fontSize }}>{ghost}</div>
      <div className="led-readout-val" style={{ fontSize }}>{value}</div>
      <span className="led-readout-label">{label}</span>
    </div>
  )
}

// ── Analysis indicator ────────────────────────────────────────────────────────

function AnalysisIndicator({ state, onAnalyze, hasTrack }: {
  state: AnalysisState
  onAnalyze: () => void
  hasTrack: boolean
}): JSX.Element | null {
  if (!hasTrack) return null
  if (state === 'reading-tags' || state === 'analyzing') {
    return (
      <span className="text-[10px] shrink-0 animate-pulse" style={{ color: 'var(--deck-mute)' }}>
        {state === 'reading-tags' ? 'reading tags…' : 'analysing…'}
      </span>
    )
  }
  if (state === 'idle' || state === 'error') {
    return (
      <button
        onClick={onAnalyze}
        className="text-[10px] shrink-0 transition-colors"
        style={{ color: 'rgba(216,106,74,0.6)' }}
        onMouseEnter={(e) => ((e.target as HTMLElement).style.color = 'var(--deck-spot)')}
        onMouseLeave={(e) => ((e.target as HTMLElement).style.color = 'rgba(216,106,74,0.6)')}
        title="Analyse BPM and key from audio"
      >
        {state === 'error' ? 'retry analysis' : 'analyse'}
      </button>
    )
  }
  return null
}

// ── BeatgridEditPanel ─────────────────────────────────────────────────────────

interface BeatgridEditPanelProps {
  bpm: number
  offsetMs: number
  markerCount: number
  autoRunning: boolean
  onNudgeBpm: (delta: number) => void
  onNudgeOffset: (deltaMs: number) => void
  onSetBeatHere: () => void
  onTap: () => void
  onAuto: () => void
  onSave: () => void
  onCancel: () => void
}

function BeatgridEditPanel({
  bpm, offsetMs, markerCount, autoRunning,
  onNudgeBpm, onNudgeOffset, onSetBeatHere, onTap, onAuto, onSave, onCancel,
}: BeatgridEditPanelProps): JSX.Element {
  const BTN: React.CSSProperties = { color: 'var(--deck-mute)', borderColor: 'rgba(110,101,83,0.35)' }
  const BTN_CLS = 'h-6 px-1.5 rounded text-[9px] font-bold border transition-colors deck-btn'
  const ACT_CLS = 'h-6 px-2 rounded text-[9px] font-bold border transition-colors'

  return (
    <div className="shrink-0 border-t px-2 py-1.5 space-y-1"
      style={{ borderColor: 'rgba(216,106,74,0.2)', background: 'rgba(216,106,74,0.04)' }}>
      {/* Row 1: BPM */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[8px] uppercase tracking-[0.15em] w-8 shrink-0" style={{ color: 'rgba(216,106,74,0.7)' }}>BPM</span>

        {([-1, -0.1, -0.01] as const).map((d) => (
          <button key={d} onClick={() => onNudgeBpm(d)} className={BTN_CLS} style={BTN}>{d}</button>
        ))}

        <span className="px-1.5 text-[13px] font-bold tabular-nums select-none min-w-[4.5rem] text-center"
          style={{ color: 'var(--deck-ink)' }}>
          {bpm.toFixed(2)}
        </span>

        {([0.01, 0.1, 1] as const).map((d) => (
          <button key={d} onClick={() => onNudgeBpm(d)} className={BTN_CLS} style={BTN}>+{d}</button>
        ))}

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <button onClick={() => onNudgeBpm(-(bpm / 2))} className={BTN_CLS} style={BTN} title="Halve BPM">½</button>
        <button onClick={() => onNudgeBpm(bpm)}         className={BTN_CLS} style={BTN} title="Double BPM">×2</button>

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <button
          onClick={onTap}
          className={ACT_CLS}
          style={{ borderColor: 'rgba(110,101,83,0.35)', color: 'var(--deck-mute)' }}
          title="Tap to detect tempo"
        >TAP</button>

        <div className="flex-1" />

        <span className="text-[8px] tabular-nums" style={{ color: 'rgba(235,229,211,0.2)' }}>{markerCount} beats</span>
      </div>

      {/* Row 2: Offset + actions */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[8px] uppercase tracking-[0.15em] w-8 shrink-0" style={{ color: 'rgba(216,106,74,0.7)' }}>POS</span>

        {([-10, -1, -0.1] as const).map((d) => (
          <button key={d} onClick={() => onNudgeOffset(d)} className={BTN_CLS} style={BTN}>{d}ms</button>
        ))}

        <span className="px-1.5 text-[11px] font-bold tabular-nums select-none min-w-[4.5rem] text-center"
          style={{ color: 'var(--deck-ink)' }}>
          {(offsetMs / 1000).toFixed(3)}s
        </span>

        {([0.1, 1, 10] as const).map((d) => (
          <button key={d} onClick={() => onNudgeOffset(d)} className={BTN_CLS} style={BTN}>+{d}ms</button>
        ))}

        <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--deck-rule)' }} />

        <button
          onClick={onSetBeatHere}
          className={ACT_CLS}
          style={{ borderColor: 'rgba(110,101,83,0.35)', color: 'var(--deck-mute)' }}
          title="Snap nearest beat to the current playhead position"
        >SET BEAT HERE</button>

        <button
          onClick={onAuto}
          disabled={autoRunning}
          className={`${ACT_CLS} disabled:opacity-40`}
          style={{ borderColor: 'rgba(110,101,83,0.35)', color: 'var(--deck-mute)' }}
          title="Auto-detect first beat offset"
        >{autoRunning ? 'detecting…' : 'AUTO'}</button>

        <div className="flex-1" />

        <button
          onClick={onCancel}
          className={ACT_CLS}
          style={{ borderColor: 'rgba(110,101,83,0.35)', color: 'var(--deck-mute)' }}
        >cancel</button>
        <button
          onClick={onSave}
          className={ACT_CLS}
          style={{ borderColor: 'rgba(216,106,74,0.6)', background: 'rgba(216,106,74,0.15)', color: 'rgba(216,106,74,0.9)' }}
        >SAVE GRID</button>
      </div>
    </div>
  )
}

interface HotCuePadProps {
  label: string; index?: number; cue: CuePoint | undefined
  color: string; disabled: boolean
  onPress: () => void; onSet: () => void; onClear: () => void
}

function HotCuePad({ label, cue, color, disabled, onPress, onSet, onClear }: HotCuePadProps): JSX.Element {
  return (
    <button
      onClick={onPress}
      onContextMenu={(e) => { e.preventDefault(); cue ? onClear() : onSet() }}
      disabled={disabled}
      title={cue ? `${label}: ${fmt(cue.positionMs / 1000, true)} — click to jump · right-click clear` : `${label}: right-click to set`}
      className="relative h-8 w-9 rounded text-[10px] font-black tracking-wide transition-all disabled:opacity-25 disabled:cursor-default"
      style={
        cue
          ? { background: `linear-gradient(180deg,${color}44 0%,${color}18 100%)`, border: `1px solid ${color}`, color, boxShadow: `0 0 6px ${color}33` }
          : { background: 'rgba(42,36,28,0.4)', border: '1px solid rgba(42,36,28,0.8)', color: 'rgba(110,101,83,0.7)' }
      }
    >
      {label}
      {cue && (
        <span className="absolute bottom-0.5 left-0 right-0 text-center font-normal leading-none" style={{ fontSize: 7, color: color + 'aa' }}>
          {fmt(cue.positionMs / 1000)}
        </span>
      )}
    </button>
  )
}
