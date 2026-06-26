/**
 * Mixer — Teenage Engineering–influenced channel strip.
 *
 * Design principles:
 *  • Flat matte surfaces — no gradients on UI chrome
 *  • Engraved silk-screen labels — small, tracked, uppercase JetBrains Mono
 *  • Precision tick marks — everything on a tight grid
 *  • App design tokens throughout (--accent-rgb, --border-rgb, --panel-deep)
 *  • Indicator-only knobs — no decorative arcs, position speaks for itself
 */
import { useEffect, useRef, useCallback } from 'react'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { useMixerStore } from '../store/mixerStore'
import { useRecordingStore } from '../store/recordingStore'
import type { AudioEngineContract } from '../lib/audioEngineContract'

// ── Knob ──────────────────────────────────────────────────────────────────────
// Flat circle, single indicator line, range marks at ±135°. Centre-split: 0 =
// 12 o'clock. Drag ↑ = up / drag ↓ = down · double-click = reset. Size, pointer
// colour and the optional ring come from the design's per-band differentiation
// (TRIM stone · HI/MID/LOW terracotta · FILTER ochre + ring).

const linToDb = (lin: number): number => 20 * Math.log10(Math.max(0.0001, lin))

function Knob({
  label, value, min = -24, max = 6, size = 30, pointer, glow, ring = false,
  sensitivity = 80, reset = 0, format, onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  size?: number
  pointer?: string
  glow?: string
  ring?: boolean
  sensitivity?: number
  reset?: number
  format?: (v: number) => { text: string; hot?: boolean }
  onChange: (v: number) => void
}): JSX.Element {
  const range = max - min
  const angleDeg = value <= 0 ? (value / Math.abs(min)) * 135 : (value / max) * 135

  const startRef = useRef<{ y: number; v: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = { y: e.clientY, v: value }
  }, [value])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const raw = startRef.current.v + (startRef.current.y - e.clientY) / sensitivity * range
    onChange(Math.max(min, Math.min(max, Math.round(raw * 100) / 100)))
  }, [min, max, range, sensitivity, onChange])

  const onPointerUp = useCallback(() => { startRef.current = null }, [])

  const fmt = format
    ? format(value)
    : { text: Math.abs(value) < 0.5 ? '0' : value > 0 ? `+${value.toFixed(0)}` : value.toFixed(0), hot: value <= min + 1.5 }

  const knobStyle = {
    '--rot': `${angleDeg}deg`,
    '--knob-size': `${size}px`,
    ...(pointer ? { '--knob-pointer': pointer } : {}),
    ...(glow ? { '--knob-pointer-glow': glow } : {}),
    touchAction: 'none',
  } as React.CSSProperties

  return (
    <div className="flex items-center gap-2 w-full select-none">
      <div
        className={`knob cursor-ns-resize${ring ? ' knob-ring' : ''}`}
        style={knobStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => onChange(reset)}
        title={`${label}: ${fmt.text} — drag ↑↓ · double-click to reset`}
      />
      <div className="flex flex-col" style={{ minWidth: 0 }}>
        <span
          className="font-mono text-[10px] font-bold uppercase tracking-[0.02em] leading-none"
          style={{ color: 'var(--deck-mute)' }}
        >{label}</span>
        <span
          className="font-mono text-[10px] tabular-nums leading-none mt-0.5"
          style={{ color: fmt.hot ? 'var(--deck-spot)' : 'var(--deck-ink)' }}
        >{fmt.text}</span>
      </div>
    </div>
  )
}

// ── VU Meter ─────────────────────────────────────────────────────────────────
// 12-segment LED ladder — lit moss → ochre → red, peak-hold on the top segment.
// Driven by a RAF loop reading the engine level (no React re-render per frame).

const VU_SEGMENTS = 12
const vuColor = (i: number): string => (i >= 10 ? '#C24E4E' : i >= 7 ? '#C9A02C' : '#6E8059')

function VuMeter({ getLevel }: { getLevel: () => number }): JSX.Element {
  const segs    = useRef<(HTMLDivElement | null)[]>([])
  const peakLv  = useRef(0)
  const peakTk  = useRef(0)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const lv  = getLevel()
      if (lv >= peakLv.current) { peakLv.current = lv; peakTk.current = 0 }
      else { peakTk.current++; if (peakTk.current > 40) peakLv.current *= 0.95 }
      const lit  = Math.round(lv * VU_SEGMENTS)
      const peak = Math.round(peakLv.current * VU_SEGMENTS) - 1
      for (let i = 0; i < VU_SEGMENTS; i++) {
        const el = segs.current[i]
        if (!el) continue
        const on = i < lit || i === peak
        el.style.background = on ? vuColor(i) : 'rgba(255,255,255,0.06)'
        el.style.boxShadow  = on && i >= 10 ? '0 0 4px rgba(194,78,78,0.6)' : 'none'
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [getLevel])

  return (
    <div className="flex gap-px" style={{ height: 6 }}>
      {Array.from({ length: VU_SEGMENTS }, (_, i) => (
        <div
          key={i}
          ref={(el) => { segs.current[i] = el }}
          className="flex-1"
          style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 1 }}
        />
      ))}
    </div>
  )
}

// ── Vertical Fader ────────────────────────────────────────────────────────────
// TE-style: hairline track, flat rectangular knob, engraved tick marks.

function VerticalFader({ value, onChange }: { value: number; onChange: (v: number) => void }): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const held     = useRef(false)

  const calc = (y: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, 1 - (y - r.top) / r.height)) * 100) / 100
  }

  const onDown = (e: React.PointerEvent) => {
    held.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onChange(calc(e.clientY))
  }
  const onMove = (e: React.PointerEvent) => { if (held.current) onChange(calc(e.clientY)) }
  const onUp   = () => { held.current = false }
  const filled = `${(1 - value) * 100}%`

  // Tick marks at 0%, 25%, 50%, 75%, 100%
  const TICKS = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-1 min-h-0 w-full justify-center relative" style={{ minHeight: 80 }}>
      {/* Tick marks (left side of track) */}
      <div className="absolute left-0 top-0 bottom-0 w-3 flex flex-col justify-between py-0">
        {TICKS.map((t, i) => (
          <div key={i} className="flex items-center" style={{ height: 1 }}>
            <div className="h-px" style={{
              width: t === 0.5 ? 6 : 4,
              background: t === 0.5 ? 'rgba(110,101,83,0.5)' : 'rgba(110,101,83,0.25)',
            }} />
          </div>
        ))}
      </div>

      {/* Track + knob */}
      <div
        ref={trackRef}
        className="relative flex-1 cursor-pointer"
        style={{ width: 2, maxWidth: 2, margin: '0 12px' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => onChange(0.8)}
        title="Channel volume — double-click to reset"
      >
        {/* Track hairline */}
        <div className="absolute inset-y-0 left-0" style={{ background: 'rgba(110,101,83,0.5)', width: 1 }} />

        {/* Active fill above knob */}
        <div className="absolute left-0" style={{
          top: 0, height: filled, width: 1,
          background: 'rgba(216,106,74,0.5)',
        }} />

        {/* Fader knob — flat rectangular cap */}
        <div className="absolute" style={{
          top: `calc(${filled} - 5px)`, left: -9,
          width: 20, height: 10,
          background: '#2A2620',
          border: '1px solid var(--deck-rule)',
          borderRadius: 1,
        }}>
          <div className="absolute inset-x-2" style={{ top: 4, height: 0.5, background: 'rgba(110,101,83,0.5)' }} />
        </div>
      </div>

      {/* Tick marks (right side) */}
      <div className="absolute right-0 top-0 bottom-0 w-3 flex flex-col justify-between">
        {TICKS.map((t, i) => (
          <div key={i} className="flex items-center justify-end" style={{ height: 1 }}>
            <div className="h-px" style={{
              width: t === 0.5 ? 6 : 4,
              background: t === 0.5 ? 'rgba(110,101,83,0.5)' : 'rgba(110,101,83,0.25)',
            }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Channel Strip ─────────────────────────────────────────────────────────────

function ChannelStrip({
  label, trimDb, eqHigh, eqMid, eqLow, filter, volume, isPlaying, hasTrack, engine,
  onTrim, onEq, onFilter, onVolume,
}: {
  label: 'A' | 'B'
  trimDb: number; eqHigh: number; eqMid: number; eqLow: number; filter: number
  volume: number; isPlaying: boolean; hasTrack: boolean
  engine: AudioEngineContract
  onTrim: (db: number) => void
  onEq: (band: 'high' | 'mid' | 'low', db: number) => void
  onFilter: (knob: number) => void
  onVolume: (v: number) => void
}): JSX.Element {
  const getLevel = useCallback(() => engine.getLevel(), [engine])
  const dbFmt = (v: number): { text: string } => ({ text: Math.abs(v) < 0.5 ? '0' : v > 0 ? `+${v.toFixed(0)}` : v.toFixed(0) })

  return (
    <div className="flex flex-col gap-1.5 flex-1 min-w-0 px-2 py-2">
      {/* Channel label */}
      <div className="flex items-center justify-between">
        <span
          className="font-mono text-[11px] font-bold uppercase tracking-[0.22em]"
          style={{ color: hasTrack ? 'var(--deck-spot)' : 'var(--deck-mute)' }}
        >CH {label}</span>
        {/* Activity LED */}
        <div
          style={{
            width: 4, height: 4, borderRadius: '50%',
            background: isPlaying ? 'var(--deck-spot)' : 'var(--deck-rule)',
            boxShadow: isPlaying ? '0 0 4px var(--deck-glow)' : 'none',
            transition: 'all 0.1s',
          }}
        />
      </div>

      {/* TRIM — stone pointer, smaller */}
      <Knob label="TRIM" value={trimDb} min={-12} max={12} size={22}
            pointer="#8E8473" glow="rgba(142,132,115,0.45)" sensitivity={90}
            format={dbFmt} onChange={onTrim} />

      <div style={{ height: 1, background: 'var(--deck-rule)' }} />

      {/* EQ trio — terracotta pointers (the prominent band) */}
      <div className="space-y-1.5">
        <Knob label="HI"  value={eqHigh} size={30} onChange={(v) => onEq('high', v)} />
        <Knob label="MID" value={eqMid}  size={30} onChange={(v) => onEq('mid',  v)} />
        <Knob label="LOW" value={eqLow}  size={30} onChange={(v) => onEq('low',  v)} />
      </div>

      {/* FILTER — ochre pointer + ring; centre 0 = off, ±1 = full LP/HP */}
      <div style={{ height: 1, background: 'var(--deck-rule)' }} />
      <Knob label="FILTER" value={filter} min={-1} max={1} size={26}
            pointer="#C9A02C" glow="rgba(201,160,44,0.5)" ring sensitivity={130}
            format={(v) => ({ text: Math.abs(v) < 0.05 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}` })}
            onChange={onFilter} />

      {/* Hairline divider */}
      <div style={{ height: 1, background: 'var(--deck-rule)' }} />

      {/* VU meter + label */}
      <div className="space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color: 'var(--deck-mute)' }}>level</span>
          <span className="font-mono text-[10px] tabular-nums" style={{ color: 'rgba(235,229,211,0.4)' }}>
            {Math.round(volume * 100)}
          </span>
        </div>
        <VuMeter getLevel={getLevel} />
      </div>

      {/* Channel fader */}
      <VerticalFader value={volume} onChange={onVolume} />
    </div>
  )
}

// ── Crossfader ────────────────────────────────────────────────────────────────
// Custom fader — no native range input styling quirks.

function Crossfader({ value, onChange }: { value: number; onChange: (v: number) => void }): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const held     = useRef(false)

  const calc = (x: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * 1000) / 1000
  }

  const onDown = (e: React.PointerEvent) => {
    held.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onChange(calc(e.clientX))
  }
  const onMove = (e: React.PointerEvent) => { if (held.current) onChange(calc(e.clientX)) }
  const onUp   = () => { held.current = false }

  const knobLeft = `calc(${value * 100}% - 10px)`

  return (
    <div className="space-y-1.5 px-2 pb-2">
      {/* Labels */}
      <div className="flex justify-between items-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--deck-mute)' }}>A</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.22em]" style={{ color: 'rgba(110,101,83,0.5)' }}>x-fade</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--deck-mute)' }}>B</span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        className="relative cursor-pointer"
        style={{ height: 16 }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => onChange(0.5)}
        title="Crossfader — double-click to centre"
      >
        {/* Hairline track */}
        <div className="absolute inset-x-2.5" style={{ top: 7, height: 1, background: 'rgba(110,101,83,0.5)' }} />
        {/* Centre tick */}
        <div className="absolute left-1/2 -translate-x-px" style={{ top: 4, height: 7, width: 1, background: 'rgba(110,101,83,0.4)' }} />
        {/* End ticks */}
        <div className="absolute" style={{ left: 10, top: 5, width: 1, height: 5, background: 'rgba(110,101,83,0.25)' }} />
        <div className="absolute" style={{ right: 10, top: 5, width: 1, height: 5, background: 'rgba(110,101,83,0.25)' }} />

        {/* Knob */}
        <div
          className="absolute top-1/2 -translate-y-1/2"
          style={{ left: knobLeft, width: 14, height: 9, background: 'var(--deck-spot)', borderRadius: 1 }}
        />
      </div>
    </div>
  )
}

// ── Mixer ─────────────────────────────────────────────────────────────────────

export function Mixer(): JSX.Element {
  const { volA, volB, xfade, setVolA, setVolB, setXfade } = useMixerStore()

  const setEqA     = useDeckAStore((s) => s.setEq)
  const setTrimA   = useDeckAStore((s) => s.setTrimDb)
  const setFilterA = useDeckAStore((s) => s.setFilter)
  const trimGainA  = useDeckAStore((s) => s.trimGain)
  const filterA    = useDeckAStore((s) => s.filterKnob)
  const eqHighA    = useDeckAStore((s) => s.eqHigh)
  const eqMidA     = useDeckAStore((s) => s.eqMid)
  const eqLowA     = useDeckAStore((s) => s.eqLow)
  const isPlayingA = useDeckAStore((s) => s.isPlaying)
  const hasTrackA  = useDeckAStore((s) => !!s.currentTrack)
  const engineA    = useDeckAStore((s) => s._engine)

  const setEqB     = useDeckBStore((s) => s.setEq)
  const setTrimB   = useDeckBStore((s) => s.setTrimDb)
  const setFilterB = useDeckBStore((s) => s.setFilter)
  const trimGainB  = useDeckBStore((s) => s.trimGain)
  const filterB    = useDeckBStore((s) => s.filterKnob)
  const eqHighB    = useDeckBStore((s) => s.eqHigh)
  const eqMidB     = useDeckBStore((s) => s.eqMid)
  const eqLowB     = useDeckBStore((s) => s.eqLow)
  const isPlayingB = useDeckBStore((s) => s.isPlaying)
  const hasTrackB  = useDeckBStore((s) => !!s.currentTrack)
  const engineB    = useDeckBStore((s) => s._engine)

  // Volume application lives in lib/mixBus.ts (store-level subscription), so
  // faders, crossfader and per-track trim work even when the Mixer is unmounted.

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{
        width: 148,
        background: 'var(--deck-bg-2)',
        borderLeft:  '1px solid var(--deck-rule)',
        borderRight: '1px solid var(--deck-rule)',
      }}
    >
      {/* Channel strips */}
      <div className="flex flex-1 min-h-0" style={{ borderBottom: '1px solid var(--deck-rule)' }}>
        <ChannelStrip
          label="A"
          trimDb={linToDb(trimGainA)} eqHigh={eqHighA} eqMid={eqMidA} eqLow={eqLowA} filter={filterA}
          volume={volA} isPlaying={isPlayingA} hasTrack={hasTrackA}
          engine={engineA} onTrim={setTrimA} onEq={setEqA} onFilter={setFilterA} onVolume={setVolA}
        />

        {/* Hairline divider between channels */}
        <div style={{ width: 1, background: 'var(--deck-rule)', flexShrink: 0 }} />

        <ChannelStrip
          label="B"
          trimDb={linToDb(trimGainB)} eqHigh={eqHighB} eqMid={eqMidB} eqLow={eqLowB} filter={filterB}
          volume={volB} isPlaying={isPlayingB} hasTrack={hasTrackB}
          engine={engineB} onTrim={setTrimB} onEq={setEqB} onFilter={setFilterB} onVolume={setVolB}
        />
      </div>

      {/* Crossfader */}
      <div className="shrink-0 pt-2">
        <Crossfader value={xfade} onChange={setXfade} />
      </div>

      {/* Master-mix recorder — armed switch at the foot of the mixer */}
      <RecModule />
    </div>
  )
}

// ── RecModule ─────────────────────────────────────────────────────────────────
// Master-mix recorder at the foot of the mixer column. Idle: dark switch with
// a red-ringed dot. Live: pulsing red dot + running timer. Records the master
// bus (native engine) to ~/Music/Offcut Recordings, or the Web Audio mix.

function RecModule(): JSX.Element {
  const { state, durationSeconds, startRecording, stopRecording } = useRecordingStore()
  const recording = state === 'recording'
  const saving = state === 'saving'

  const fmtDur = (s: number): string =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  return (
    <button
      className={`rec-module ${recording ? 'rec-live' : ''}`}
      onClick={() => (recording ? void stopRecording() : !saving && startRecording())}
      title={recording ? 'Stop recording and save the mix' : 'Record the master mix'}
    >
      <span className="rec-dot" />
      <span className="rec-label">
        {saving ? 'saving' : recording ? fmtDur(durationSeconds) : 'rec'}
      </span>
    </button>
  )
}
