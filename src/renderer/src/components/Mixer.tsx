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
import type { AudioEngineContract } from '../lib/audioEngineContract'

// ── EQ Knob ──────────────────────────────────────────────────────────────────
// TE-style: flat circle, single indicator line, range marks at ±140°.
// No arc decoration — the pointer position is the communication.
// Drag ↑ = boost  |  drag ↓ = cut  |  double-click = flat (0 dB)

function EqKnob({ label, value, min = -24, max = 6, onChange }: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (db: number) => void
}): JSX.Element {
  const range = max - min
  // Center-split: 0 dB = 12 o'clock (0 °), cuts go left, boosts go right
  const angleDeg = value <= 0 ? (value / Math.abs(min)) * 135 : (value / max) * 135

  const startRef = useRef<{ y: number; v: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = { y: e.clientY, v: value }
  }, [value])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const raw = startRef.current.v + (startRef.current.y - e.clientY) / 80 * range
    onChange(Math.max(min, Math.min(max, Math.round(raw * 10) / 10)))
  }, [min, max, range, onChange])

  const onPointerUp = useCallback(() => { startRef.current = null }, [])

  const isKill   = value <= min + 1.5
  const isCentre = Math.abs(value) < 0.5
  const display  = isCentre ? '0' : value > 0 ? `+${value.toFixed(0)}` : value.toFixed(0)

  return (
    <div className="flex items-center gap-2 w-full select-none">
      {/* CSS knob — body + tick ring + indicator via ::before / ::after */}
      <div
        className="knob cursor-ns-resize"
        style={{ '--rot': `${angleDeg}deg`, touchAction: 'none' } as React.CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => onChange(0)}
        title={`${label}: ${display}dB — drag ↑↓ · double-click to reset`}
      />
      {/* Label + value */}
      <div className="flex flex-col" style={{ minWidth: 0 }}>
        <span
          className="font-mono text-[8px] font-bold uppercase tracking-[0.18em] leading-none"
          style={{ color: 'var(--deck-mute)' }}
        >{label}</span>
        <span
          className="font-mono text-[7px] tabular-nums leading-none mt-0.5"
          style={{ color: isKill ? 'var(--deck-spot)' : 'var(--deck-ink)' }}
        >{display}</span>
      </div>
    </div>
  )
}

// ── VU Meter ─────────────────────────────────────────────────────────────────
// Horizontal single-bar meter — TE-minimal. No LED segments.
// Accent colour for signal, shifts warm at peaks. Peak-hold dot.

function VuMeter({ getLevel }: { getLevel: () => number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peakLv    = useRef(0)
  const peakTick  = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const ctx = canvas.getContext('2d')!
    let raf = 0

    const draw = () => {
      const lv = getLevel()
      if (lv >= peakLv.current) { peakLv.current = lv; peakTick.current = 0 }
      else { peakTick.current++; if (peakTick.current > 50) peakLv.current *= 0.96 }

      const W = canvas.width
      const H = canvas.height

      ctx.clearRect(0, 0, W, H)

      // Track
      ctx.fillStyle = 'rgba(var(--border-rgb), 0.4)'
      // Use a literal colour since canvas doesn't resolve CSS vars
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(0, 0, W, H)

      // Active fill — terracotta, shifts warm at peaks
      const fillW = Math.round(lv * W)
      if (fillW > 0) {
        const r = Math.round(216 + lv * 20)
        const g = Math.round(106 - lv * 60)
        const b = Math.round(74  - lv * 60)
        ctx.fillStyle = `rgba(${r},${g},${b},0.70)`
        ctx.fillRect(0, 0, fillW, H)
      }

      // Peak dot
      const pkX = Math.round(peakLv.current * W)
      if (pkX > 1) {
        ctx.fillStyle = 'rgba(216,106,74,0.85)'
        ctx.fillRect(Math.max(0, pkX - 1), 0, 1, H)
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [getLevel])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 3 }} />
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
  label, eqHigh, eqMid, eqLow, volume, isPlaying, hasTrack, engine, onEq, onVolume,
}: {
  label: 'A' | 'B'
  eqHigh: number; eqMid: number; eqLow: number
  volume: number; isPlaying: boolean; hasTrack: boolean
  engine: AudioEngineContract
  onEq: (band: 'high' | 'mid' | 'low', db: number) => void
  onVolume: (v: number) => void
}): JSX.Element {
  const getLevel = useCallback(() => engine.getLevel(), [engine])

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0 px-2 py-2">
      {/* Channel label */}
      <div className="flex items-center justify-between">
        <span
          className="font-mono text-[8px] font-bold uppercase tracking-[0.22em]"
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

      {/* EQ */}
      <div className="space-y-2">
        <EqKnob label="HI"  value={eqHigh} onChange={(v) => onEq('high', v)} />
        <EqKnob label="MID" value={eqMid}  onChange={(v) => onEq('mid',  v)} />
        <EqKnob label="LOW" value={eqLow}  onChange={(v) => onEq('low',  v)} />
      </div>

      {/* Hairline divider */}
      <div style={{ height: 1, background: 'var(--deck-rule)' }} />

      {/* VU meter + label */}
      <div className="space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="font-mono text-[6px] uppercase tracking-[0.2em]" style={{ color: 'var(--deck-mute)' }}>level</span>
          <span className="font-mono text-[7px] tabular-nums" style={{ color: 'rgba(235,229,211,0.4)' }}>
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
        <span className="font-mono text-[7px] uppercase tracking-[0.18em]" style={{ color: 'var(--deck-mute)' }}>A</span>
        <span className="font-mono text-[6px] uppercase tracking-[0.22em]" style={{ color: 'rgba(110,101,83,0.5)' }}>x-fade</span>
        <span className="font-mono text-[7px] uppercase tracking-[0.18em]" style={{ color: 'var(--deck-mute)' }}>B</span>
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

  const setVolumeA = useDeckAStore((s) => s.setVolume)
  const setEqA     = useDeckAStore((s) => s.setEq)
  const eqHighA    = useDeckAStore((s) => s.eqHigh)
  const eqMidA     = useDeckAStore((s) => s.eqMid)
  const eqLowA     = useDeckAStore((s) => s.eqLow)
  const isPlayingA = useDeckAStore((s) => s.isPlaying)
  const hasTrackA  = useDeckAStore((s) => !!s.currentTrack)
  const engineA    = useDeckAStore((s) => s._engine)

  const setVolumeB = useDeckBStore((s) => s.setVolume)
  const setEqB     = useDeckBStore((s) => s.setEq)
  const eqHighB    = useDeckBStore((s) => s.eqHigh)
  const eqMidB     = useDeckBStore((s) => s.eqMid)
  const eqLowB     = useDeckBStore((s) => s.eqLow)
  const isPlayingB = useDeckBStore((s) => s.isPlaying)
  const hasTrackB  = useDeckBStore((s) => !!s.currentTrack)
  const engineB    = useDeckBStore((s) => s._engine)

  useEffect(() => {
    const xA = xfade <= 0.5 ? 1 : 1 - (xfade - 0.5) * 2
    const xB = xfade >= 0.5 ? 1 : xfade * 2
    setVolumeA(volA * xA)
    setVolumeB(volB * xB)
  }, [xfade, volA, volB, setVolumeA, setVolumeB])

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
          eqHigh={eqHighA} eqMid={eqMidA} eqLow={eqLowA}
          volume={volA} isPlaying={isPlayingA} hasTrack={hasTrackA}
          engine={engineA} onEq={setEqA} onVolume={setVolA}
        />

        {/* Hairline divider between channels */}
        <div style={{ width: 1, background: 'var(--deck-rule)', flexShrink: 0 }} />

        <ChannelStrip
          label="B"
          eqHigh={eqHighB} eqMid={eqMidB} eqLow={eqLowB}
          volume={volB} isPlaying={isPlayingB} hasTrack={hasTrackB}
          engine={engineB} onEq={setEqB} onVolume={setVolB}
        />
      </div>

      {/* Crossfader */}
      <div className="shrink-0 pt-2">
        <Crossfader value={xfade} onChange={setXfade} />
      </div>
    </div>
  )
}
