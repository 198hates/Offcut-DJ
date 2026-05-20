import { useEffect, useCallback, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { DeckStore } from '../store/playerStore'
import { HOT_CUE_COLORS, HOT_CUE_LABELS, type AnalysisState } from '../store/playerStore'
import { useWaveformStore } from '../store/waveformStore'
import { Waveform } from './Waveform'
import { OverviewWaveform } from './OverviewWaveform'
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

  const isRight = label === 'B'

  // Keyboard shortcuts — Deck A: Space / 1-8, Deck B: Alt+Space / Alt+1-8
  const handleKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const wantAlt = keyMod === 'alt'
    if (e.altKey !== wantAlt) return

    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
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
  // Read beatgrid live from the library store so it updates immediately after analysis
  // without needing to reload the track onto the deck.
  const liveBeatgrid = useLibraryStore(
    (s) => s.tracks.find((t) => t.id === currentTrack?.id)?.beatgrid ?? currentTrack?.beatgrid ?? []
  )
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

  return (
    <div
      className={`flex-1 min-w-0 flex flex-col overflow-hidden relative transition-colors ${isDragOver ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-accent/90 text-white text-xs font-bold px-3 py-1.5 rounded shadow-lg tracking-widest uppercase">
            Load to Deck {label}
          </div>
        </div>
      )}

      {/* ── Track info + BPM + time ──────────────────────────────────── */}
      <div className={`flex items-center gap-2 px-2 pt-1 pb-0.5 border-b border-white/[0.10] ${isRight ? 'flex-row-reverse' : ''}`}>
        {/* Deck label chip */}
        <div className="shrink-0 px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px] font-black tracking-widest select-none">
          {label}
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold text-white/90 truncate leading-tight ${isRight ? 'text-right' : ''}`}>
            {currentTrack?.title || <span className="text-white/20 italic font-normal">No track loaded</span>}
          </p>
          <div className={`flex items-center gap-2 ${isRight ? 'flex-row-reverse' : ''}`}>
            <p className="text-[10px] text-white/55 truncate">
              {currentTrack?.artist || ''}
              {currentTrack?.album ? ` · ${currentTrack.album}` : ''}
            </p>
            <AnalysisIndicator state={analysisState} onAnalyze={analyzeCurrentTrack} hasTrack={!!currentTrack} />
            {liveBeatgrid.length > 0 && (
              <span
                title={`Beat grid · ${liveBeatgrid.length} beats`}
                className="text-[8px] font-mono text-teal-400/70 shrink-0"
              >
                grid
              </span>
            )}
          </div>
        </div>

        {/* Key LED */}
        <LedReadout
          value={currentTrack?.key || '—'}
          ghost="00A"
          label="key"
          fontSize={13}
        />

        {/* BPM LED */}
        <LedReadout
          value={currentTrack?.bpm ? currentTrack.bpm.toFixed(1) : '—.—'}
          ghost="000.0"
          label="bpm"
          fontSize={13}
        />

        {/* Time LED */}
        <LedReadout
          value={fmt(currentTime, true)}
          ghost="0:00.0"
          label={`-${fmt(remaining)}`}
          fontSize={12}
        />
      </div>

      {/* ── Overview waveform ────────────────────────────────────────── */}
      <div className="px-2 border-b border-white/[0.08]" style={{ background: 'rgba(0,0,0,0.25)' }}>
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
          beatgrid={liveBeatgrid}
          onSeek={seek}
        />
      </div>

      {/* ── Scrolling detail waveform — dominant centre element ──────── */}
      <div className="px-2 py-1 flex flex-1 min-h-0">
        <Waveform
          peaks={detailPeaks}
          lowPeaks={lowPeaks}
          midPeaks={midPeaks}
          highPeaks={highPeaks}
          waveformStyle={waveformStyle}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          beatgrid={liveBeatgrid}
          loopStart={loopStart}
          loopEnd={loopEnd}
          isLooping={isLooping}
          onSeek={seek}
          isLoading={isLoading}
        />
      </div>

      {/* ── Loop controls + pitch ─────────────────────────────────────── */}
      <div className={`flex items-center gap-1 px-2 py-0.5 border-t border-white/[0.08] ${isRight ? 'flex-row-reverse' : ''}`}>
        {/* Beat loop buttons */}
        {[0.5, 1, 2, 4, 8].map((bars) => (
          <button
            key={bars}
            onClick={() => beatLoop(bars)}
            disabled={!currentTrack}
            title={`${bars} bar loop`}
            className="h-6 px-1.5 rounded text-[10px] font-bold border border-white/[0.15] text-white/55 hover:border-accent/50 hover:text-accent/80 hover:bg-accent/10 transition-colors disabled:opacity-25"
          >
            {bars < 1 ? '½' : bars}
          </button>
        ))}

        <div className="w-px h-4 bg-white/10 mx-0.5 shrink-0" />

        {/* IN / OUT / LOOP */}
        <button onClick={setLoopIn}  disabled={!currentTrack} className="h-6 px-1.5 rounded text-[10px] font-bold border border-white/[0.15] text-white/55 hover:border-accent/50 hover:text-accent/80 transition-colors disabled:opacity-25">IN</button>
        <button onClick={setLoopOut} disabled={!currentTrack} className="h-6 px-1.5 rounded text-[10px] font-bold border border-white/[0.15] text-white/55 hover:border-accent/50 hover:text-accent/80 transition-colors disabled:opacity-25">OUT</button>
        <button
          onClick={toggleLoop}
          disabled={!currentTrack || (loopStart === null && loopEnd === null)}
          className={`h-6 px-2 rounded text-[10px] font-bold border transition-colors disabled:opacity-25 ${
            isLooping ? 'border-accent text-accent bg-accent/15' : 'border-white/[0.12] text-white/50 hover:border-accent/50 hover:text-accent/80'
          }`}
        >
          LOOP
        </button>
        <button onClick={clearLoop} disabled={!currentTrack || (loopStart === null)} className="h-6 px-1.5 rounded text-[10px] border border-white/[0.08] text-white/40 hover:text-red-400/70 transition-colors disabled:opacity-25" title="Clear loop">✕</button>

        <div className="flex-1" />

        {/* Pitch */}
        <div className={`flex items-center gap-1 ${isRight ? 'flex-row-reverse' : ''}`}>
          <span className="text-[9px] text-white/30 tabular-nums w-9 text-center">
            {playbackRate === 1 ? '±0%' : `${playbackRate > 1 ? '+' : ''}${((playbackRate - 1) * 100).toFixed(1)}%`}
          </span>
          <input
            type="range" min={0.92} max={1.08} step={0.001}
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
            onDoubleClick={() => setPlaybackRate(1.0)}
            disabled={!currentTrack}
            className="w-16 h-1 cursor-pointer accent-accent disabled:opacity-25"
            title="Pitch/tempo — double-click to reset"
          />
          <span className="text-[9px] text-white/40 uppercase tracking-wider">Pitch</span>
        </div>
      </div>

      {/* ── Transport + hotcue pads ───────────────────────────────────── */}
      <div className={`flex items-center gap-1 px-2 pb-1.5 pt-0.5 flex-wrap border-t border-white/[0.08] ${isRight ? 'flex-row-reverse' : ''}`}>
        <button
          onClick={pressCue}
          disabled={!currentTrack}
          className="h-8 px-2.5 rounded text-[10px] font-black tracking-widest border border-white/[0.18] text-white/70 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-25"
        >
          CUE
        </button>
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="h-8 w-10 rounded flex items-center justify-center text-white bg-accent hover:bg-accent-hover transition-colors disabled:opacity-25 text-xs font-bold"
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <div className="w-px h-5 bg-white/[0.08] mx-0.5 shrink-0" />

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

        <div className="w-px h-5 bg-white/[0.08] mx-0.5 shrink-0" />

        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          className="h-8 px-2 rounded text-[10px] font-bold border border-amber-500/30 text-amber-400/70 hover:bg-amber-500/15 transition-colors disabled:opacity-25"
        >
          MEM
        </button>

        {memoryCues.map((c, i) => (
          <button
            key={i}
            onClick={() => seek(c.positionMs / 1000)}
            className="h-8 px-2 rounded text-[10px] font-mono border border-amber-500/20 text-amber-400/50 hover:bg-amber-500/10 transition-colors tabular-nums"
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
      <span className="text-[10px] text-white/30 shrink-0 animate-pulse">
        {state === 'reading-tags' ? 'reading tags…' : 'analysing…'}
      </span>
    )
  }
  if (state === 'idle' || state === 'error') {
    return (
      <button
        onClick={onAnalyze}
        className="text-[10px] text-accent/60 hover:text-accent shrink-0 transition-colors"
        title="Analyse BPM and key from audio"
      >
        {state === 'error' ? 'retry analysis' : 'analyse'}
      </button>
    )
  }
  return null
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
          : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.2)' }
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
