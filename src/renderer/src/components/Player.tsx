import { useEffect, useCallback } from 'react'
import { usePlayerStore, HOT_CUE_COLORS, HOT_CUE_LABELS } from '../store/playerStore'
import { Waveform } from './Waveform'
import { OverviewWaveform } from './OverviewWaveform'
import type { CuePoint } from '@shared/types'

function fmt(s: number, ms = false): string {
  if (!isFinite(s) || s < 0) return ms ? '0:00.0' : '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const base = `${m}:${sec.toString().padStart(2, '0')}`
  if (!ms) return base
  const tenth = Math.floor((s % 1) * 10)
  return `${base}.${tenth}`
}

export function Player(): JSX.Element {
  const {
    currentTrack, isPlaying, currentTime, duration,
    waveformPeaks, detailPeaks, isLoading, mainCueTime,
    togglePlay, seek, setVolume, pressCue,
    setCue, clearCue, jumpToCue, setMemoryCue
  } = usePlayerStore()

  // Keyboard shortcuts
  const handleKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
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
  }, [togglePlay, setCue, jumpToCue])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const hotcues = HOT_CUE_LABELS.map((label, i) => ({
    label, index: i,
    cue: currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === i),
    color: HOT_CUE_COLORS[i]
  }))

  const memoryCues = currentTrack?.cuePoints.filter((c) => c.type === 'memory') ?? []
  const remaining = duration - currentTime

  return (
    <div className="bg-surface-900 border-t border-white/[0.06] shrink-0 select-none" style={{ minHeight: 220 }}>

      {/* ── Row 1: Track info + BPM + time ─────────────────────────────── */}
      <div className="flex items-start gap-4 px-4 pt-2.5 pb-1.5 border-b border-white/[0.04]">
        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate leading-tight">
            {currentTrack?.title || (currentTrack ? '—' : 'No track loaded')}
          </p>
          <p className="text-xs text-white/50 truncate mt-0.5">
            {currentTrack?.artist || ''}
            {currentTrack?.album ? ` · ${currentTrack.album}` : ''}
          </p>
        </div>

        {/* BPM */}
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold text-white tabular-nums leading-none">
            {currentTrack?.bpm ? currentTrack.bpm.toFixed(2) : '—'}
          </p>
          <p className="text-xs text-white/30 mt-0.5">BPM</p>
        </div>

        {/* Key */}
        <div className="text-right shrink-0 w-10">
          <p className="text-lg font-semibold text-accent leading-none">
            {currentTrack?.key || '—'}
          </p>
          <p className="text-xs text-white/30 mt-0.5">KEY</p>
        </div>

        {/* Time */}
        <div className="text-right shrink-0">
          <p className="text-xl font-bold text-white tabular-nums font-mono leading-none">
            {fmt(currentTime, true)}
          </p>
          <p className="text-xs text-white/30 tabular-nums font-mono mt-0.5">
            -{fmt(remaining)}
          </p>
        </div>
      </div>

      {/* ── Row 2: Overview waveform ───────────────────────────────────── */}
      <div className="px-2 py-0.5 bg-black/20">
        <OverviewWaveform
          peaks={waveformPeaks}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          onSeek={seek}
        />
      </div>

      {/* ── Row 3: Scrolling detail waveform ──────────────────────────── */}
      <div className="px-2 py-1 flex" style={{ height: 80 }}>
        <Waveform
          peaks={detailPeaks}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          onSeek={seek}
          isLoading={isLoading}
        />
      </div>

      {/* ── Row 4: Transport + hotcue pads ───────────────────────────── */}
      <div className="flex items-center gap-2 px-3 pb-2.5">
        {/* CUE button */}
        <button
          onClick={pressCue}
          disabled={!currentTrack}
          className="h-8 px-3 rounded text-xs font-bold tracking-widest transition-colors disabled:opacity-30 border border-white/20 text-white/80 hover:bg-white/10 hover:text-white"
        >
          CUE
        </button>

        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="h-8 w-10 rounded flex items-center justify-center text-white transition-colors disabled:opacity-30 bg-accent hover:bg-accent-hover text-sm font-bold"
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <div className="w-px h-6 bg-white/10 mx-1 shrink-0" />

        {/* Hotcue pads A–H */}
        {hotcues.map(({ label, index, cue, color }) => (
          <HotCuePad
            key={index}
            label={label}
            index={index}
            cue={cue}
            color={color}
            disabled={!currentTrack}
            onPress={() => cue ? jumpToCue(index) : setCue(index)}
            onSet={() => setCue(index)}
            onClear={() => clearCue(index)}
          />
        ))}

        <div className="w-px h-6 bg-white/10 mx-1 shrink-0" />

        {/* Memory cue */}
        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          title="Set memory cue at current position"
          className="h-8 px-2.5 rounded text-xs font-bold border transition-colors disabled:opacity-30 border-amber-500/40 text-amber-400/80 hover:bg-amber-500/20 hover:text-amber-300"
        >
          MEM
        </button>

        {/* Memory cue jump buttons */}
        {memoryCues.map((c, i) => (
          <MemoryCueBtn key={i} cue={c} onJump={() => seek(c.positionMs / 1000)} />
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Volume */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-white/30 text-xs">VOL</span>
          <input
            type="range" min={0} max={1} step={0.01} defaultValue={0.8}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-20 h-1 cursor-pointer accent-accent"
          />
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface HotCuePadProps {
  label: string
  index: number
  cue: CuePoint | undefined
  color: string
  disabled: boolean
  onPress: () => void
  onSet: () => void
  onClear: () => void
}

function HotCuePad({ label, index, cue, color, disabled, onPress, onSet, onClear }: HotCuePadProps): JSX.Element {
  return (
    <button
      onClick={onPress}
      onContextMenu={(e) => { e.preventDefault(); cue ? onClear() : onSet() }}
      disabled={disabled}
      title={
        cue
          ? `${label} · ${fmt(cue.positionMs / 1000, true)} — click to jump · right-click to clear`
          : `${label} · empty — right-click to set · Shift+${index + 1} shortcut`
      }
      className="relative h-8 w-9 rounded text-xs font-black tracking-wider transition-all disabled:opacity-25 disabled:cursor-default"
      style={
        cue
          ? {
              background: `linear-gradient(180deg, ${color}55 0%, ${color}22 100%)`,
              border: `1px solid ${color}`,
              color,
              boxShadow: `0 0 6px ${color}44`
            }
          : {
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.2)'
            }
      }
    >
      {label}
      {cue && (
        <span
          className="absolute bottom-0.5 left-0 right-0 text-center leading-none font-normal"
          style={{ fontSize: 7, color: color + 'bb' }}
        >
          {fmt(cue.positionMs / 1000)}
        </span>
      )}
    </button>
  )
}

function MemoryCueBtn({ cue, onJump }: { cue: CuePoint; onJump: () => void }): JSX.Element {
  return (
    <button
      onClick={onJump}
      title={`Memory cue at ${fmt(cue.positionMs / 1000, true)}`}
      className="h-8 px-2 rounded text-xs font-mono border border-amber-500/25 text-amber-400/60 hover:bg-amber-500/15 hover:text-amber-300 transition-colors tabular-nums"
    >
      {fmt(cue.positionMs / 1000)}
    </button>
  )
}
