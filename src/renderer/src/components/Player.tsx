import { useEffect, useCallback } from 'react'
import { usePlayerStore, HOT_CUE_COLORS, HOT_CUE_LABELS } from '../store/playerStore'
import { Waveform } from './Waveform'
import type { CuePoint } from '@shared/types'

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function fmtMs(ms: number): string {
  return fmt(ms / 1000)
}

export function Player(): JSX.Element {
  const {
    currentTrack, isPlaying, currentTime, duration,
    waveformPeaks, isLoading,
    togglePlay, seek, setVolume,
    setCue, clearCue, jumpToCue, setMemoryCue
  } = usePlayerStore()

  // Keyboard shortcuts (Space = play/pause, 1-8 = jump/set hotcue)
  const handleKey = useCallback((e: KeyboardEvent) => {
    // Don't steal keys from inputs
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      togglePlay()
    }
    const digit = e.code.match(/^Digit([1-8])$/)?.[1]
    if (digit) {
      const idx = parseInt(digit) - 1
      if (e.shiftKey) {
        setCue(idx)
      } else {
        jumpToCue(idx)
      }
    }
  }, [togglePlay, setCue, jumpToCue])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const hotcues = HOT_CUE_LABELS.map((label, i) => {
    const cue = currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === i)
    return { label, index: i, cue, color: HOT_CUE_COLORS[i] }
  })

  return (
    <div className="bg-surface-900 border-t border-white/5 shrink-0 select-none">
      {/* ── Top row: info + waveform + transport ─────────────────────────── */}
      <div className="flex items-center gap-3 px-4 pt-2.5 pb-1">
        {/* Track info */}
        <div className="w-44 shrink-0">
          {currentTrack ? (
            <>
              <p className="text-sm font-medium text-white truncate leading-tight">
                {currentTrack.title || 'Untitled'}
              </p>
              <p className="text-xs text-white/50 truncate leading-tight mt-0.5">
                {currentTrack.artist || 'Unknown artist'}
              </p>
              <p className="text-xs text-white/25 mt-0.5">
                {currentTrack.bpm ? `${currentTrack.bpm.toFixed(1)} BPM` : '—'}
                {currentTrack.key ? ` · ${currentTrack.key}` : ''}
              </p>
            </>
          ) : (
            <p className="text-xs text-white/20">Double-click a track to load</p>
          )}
        </div>

        {/* Play/pause */}
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="w-9 h-9 shrink-0 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-30 disabled:cursor-default flex items-center justify-center text-white transition-colors text-sm"
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        {/* Elapsed */}
        <span className="text-xs text-white/40 font-mono w-10 shrink-0 text-right tabular-nums">
          {fmt(currentTime)}
        </span>

        {/* Waveform */}
        <Waveform
          peaks={waveformPeaks}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          onSeek={seek}
          isLoading={isLoading}
        />

        {/* Remaining */}
        <span className="text-xs text-white/40 font-mono w-10 shrink-0 tabular-nums">
          {currentTrack ? `-${fmt(duration - currentTime)}` : '0:00'}
        </span>

        {/* Volume */}
        <div className="shrink-0 flex items-center gap-1.5 w-20">
          <span className="text-white/30 text-xs select-none">▲</span>
          <input
            type="range" min={0} max={1} step={0.01} defaultValue={0.8}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="flex-1 h-1 cursor-pointer accent-accent"
          />
        </div>
      </div>

      {/* ── Bottom row: hotcue pads ───────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-4 pb-2">
        {hotcues.map(({ label, index, cue, color }) => (
          <HotCuePad
            key={index}
            label={label}
            cue={cue}
            color={color}
            disabled={!currentTrack}
            onPress={() => {
              if (cue) jumpToCue(index)
              else setCue(index)
            }}
            onSet={() => setCue(index)}
            onClear={() => clearCue(index)}
          />
        ))}

        <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />

        {/* Memory cue */}
        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          title="Set memory cue"
          className="h-6 px-2 rounded text-xs font-medium border transition-colors disabled:opacity-30 disabled:cursor-default border-amber-500/40 text-amber-400 hover:bg-amber-500/20"
        >
          MEM
        </button>

        {/* Memory cue list */}
        {currentTrack?.cuePoints
          .filter((c) => c.type === 'memory')
          .map((c, i) => (
            <button
              key={i}
              onClick={() => usePlayerStore.getState().seek(c.positionMs / 1000)}
              title={`Memory cue at ${fmtMs(c.positionMs)}`}
              className="h-6 px-2 rounded text-xs font-mono border border-amber-500/30 text-amber-400/70 hover:bg-amber-500/20 transition-colors"
            >
              {fmtMs(c.positionMs)}
            </button>
          ))}
      </div>
    </div>
  )
}

interface HotCuePadProps {
  label: string
  cue: CuePoint | undefined
  color: string
  disabled: boolean
  onPress: () => void
  onSet: () => void
  onClear: () => void
}

function HotCuePad({ label, cue, color, disabled, onPress, onSet, onClear }: HotCuePadProps): JSX.Element {
  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (cue) onClear()
    else onSet()
  }

  return (
    <button
      onClick={onPress}
      onContextMenu={handleContextMenu}
      disabled={disabled}
      title={
        cue
          ? `${label}: ${fmt(cue.positionMs / 1000)} — click to jump · right-click to clear`
          : `${label}: right-click to set`
      }
      className="relative h-6 w-9 rounded text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-default"
      style={
        cue
          ? { backgroundColor: color + '33', borderColor: color, border: `1px solid ${color}`, color }
          : { backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.25)' }
      }
    >
      {label}
    </button>
  )
}
