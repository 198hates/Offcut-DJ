import { useEffect, useCallback } from 'react'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { DeckStore } from '../store/playerStore'
import { HOT_CUE_COLORS, HOT_CUE_LABELS } from '../store/playerStore'
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
  const {
    currentTrack, isPlaying, currentTime, duration,
    waveformPeaks, detailPeaks, isLoading, mainCueTime,
    togglePlay, seek, pressCue,
    setCue, clearCue, jumpToCue, setMemoryCue
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

  const hotcues = HOT_CUE_LABELS.map((lbl, i) => ({
    label: lbl, index: i,
    cue: currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === i),
    color: HOT_CUE_COLORS[i]
  }))
  const memoryCues = currentTrack?.cuePoints.filter((c) => c.type === 'memory') ?? []
  const remaining = duration - currentTime

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

      {/* ── Track info + BPM + time ──────────────────────────────────── */}
      <div className={`flex items-start gap-3 px-3 pt-2 pb-1.5 border-b border-white/[0.04] ${isRight ? 'flex-row-reverse' : ''}`}>
        {/* Deck label badge */}
        <div className="shrink-0 flex items-center justify-center w-7 h-7 rounded-full bg-accent/20 border border-accent/40 text-accent text-xs font-black">
          {label}
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold text-white truncate leading-tight ${isRight ? 'text-right' : ''}`}>
            {currentTrack?.title || <span className="text-white/20 italic font-normal text-xs">No track loaded</span>}
          </p>
          <p className={`text-xs text-white/45 truncate mt-0.5 ${isRight ? 'text-right' : ''}`}>
            {currentTrack?.artist || ''}
            {currentTrack?.album ? ` · ${currentTrack.album}` : ''}
          </p>
        </div>

        {/* Key */}
        <div className={`shrink-0 ${isRight ? 'text-left' : 'text-right'}`}>
          <p className="text-base font-bold text-accent leading-none">{currentTrack?.key || '—'}</p>
          <p className="text-[10px] text-white/25 mt-0.5">KEY</p>
        </div>

        {/* BPM */}
        <div className={`shrink-0 ${isRight ? 'text-left' : 'text-right'}`}>
          <p className="text-xl font-bold text-white tabular-nums leading-none">
            {currentTrack?.bpm ? currentTrack.bpm.toFixed(2) : '—'}
          </p>
          <p className="text-[10px] text-white/25 mt-0.5">BPM</p>
        </div>

        {/* Time */}
        <div className={`shrink-0 ${isRight ? 'text-left' : 'text-right'}`}>
          <p className="text-base font-bold text-white tabular-nums font-mono leading-none">{fmt(currentTime, true)}</p>
          <p className="text-[10px] text-white/30 tabular-nums font-mono mt-0.5">-{fmt(remaining)}</p>
        </div>
      </div>

      {/* ── Overview waveform ────────────────────────────────────────── */}
      <div className="px-2 bg-black/25 border-b border-white/[0.04]">
        <OverviewWaveform
          peaks={waveformPeaks}
          duration={duration}
          currentTime={currentTime}
          cuePoints={currentTrack?.cuePoints ?? []}
          mainCueTime={mainCueTime}
          onSeek={seek}
        />
      </div>

      {/* ── Scrolling detail waveform ─────────────────────────────────── */}
      <div className="px-2 py-1 flex flex-1 min-h-0">
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

      {/* ── Transport + hotcue pads ───────────────────────────────────── */}
      <div className={`flex items-center gap-1.5 px-2 pb-2 pt-0.5 flex-wrap ${isRight ? 'flex-row-reverse' : ''}`}>
        <button
          onClick={pressCue}
          disabled={!currentTrack}
          className="h-9 px-3 rounded text-xs font-black tracking-widest border border-white/20 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-25"
        >
          CUE
        </button>
        <button
          onClick={togglePlay}
          disabled={!currentTrack}
          className="h-9 w-11 rounded flex items-center justify-center text-white bg-accent hover:bg-accent-hover transition-colors disabled:opacity-25 text-sm font-bold"
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <div className="w-px h-6 bg-white/10 mx-0.5 shrink-0" />

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

        <div className="w-px h-6 bg-white/10 mx-0.5 shrink-0" />

        <button
          onClick={setMemoryCue}
          disabled={!currentTrack}
          className="h-9 px-2 rounded text-xs font-bold border border-amber-500/40 text-amber-400/80 hover:bg-amber-500/20 transition-colors disabled:opacity-25"
        >
          MEM
        </button>

        {memoryCues.map((c, i) => (
          <button
            key={i}
            onClick={() => seek(c.positionMs / 1000)}
            className="h-9 px-2 rounded text-xs font-mono border border-amber-500/25 text-amber-400/60 hover:bg-amber-500/15 transition-colors tabular-nums"
          >
            {fmt(c.positionMs / 1000)}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── HotCuePad ─────────────────────────────────────────────────────────────────

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
      className="relative h-9 w-10 rounded text-xs font-black tracking-wide transition-all disabled:opacity-25 disabled:cursor-default"
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
