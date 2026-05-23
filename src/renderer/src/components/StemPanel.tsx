/**
 * StemPanel — FN-BUS vocabulary controls for the four stem buses.
 *
 * Displayed as a compact panel inside the deck when STEMS is toggled on.
 * Each row: colour blip + label + [MUTE] [SOLO] + gain trim slider.
 *
 * Actual audio routing lives in the engine (Phase 4+). This component
 * drives the UI state that the engine will eventually read. Works against
 * mock / no-engine configurations without errors.
 */

import type { StemKind, StemState } from '@shared/types'

// ── Stem catalogue ────────────────────────────────────────────────────────────

interface StemMeta {
  label: string
  /** Pictogram element (SVG path shorthand) */
  icon: JSX.Element
  /** Earth-tone colour for this stem bus. */
  color: string
}

// Each stem maps to one of the categorical earth tones.
const STEM_META: Record<StemKind, StemMeta> = {
  drums: {
    label: 'drums',
    color: '#8E8473',   // cat.stone — neutral percussive
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <ellipse cx="7" cy="10" rx="5" ry="2.5"/>
        <path d="M2 10V5.5"/>
        <path d="M12 10V5.5"/>
        <ellipse cx="7" cy="5.5" rx="5" ry="2"/>
        <line x1="5" y1="3" x2="3.5" y2="1"/>
        <line x1="9" y1="3" x2="10.5" y2="1"/>
      </svg>
    ),
  },
  bass: {
    label: 'bass',
    color: '#B07A4E',   // cat.clay — warm low-end earth
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M4 2 L4 9 Q4 12 7 12 Q10 12 10 9 Q10 6.5 8 6.5 Q6 6.5 6 8"/>
        <circle cx="4" cy="2" r="1" fill="currentColor" stroke="none"/>
        <line x1="10" y1="1.5" x2="10" y2="5"/>
      </svg>
    ),
  },
  vocals: {
    label: 'vocals',
    color: '#B86E72',   // cat.rose — warm human
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="5" y="1.5" width="4" height="7" rx="2"/>
        <path d="M3 7.5 Q3 11 7 11 Q11 11 11 7.5"/>
        <line x1="7" y1="11" x2="7" y2="13"/>
        <line x1="5" y1="13" x2="9" y2="13"/>
      </svg>
    ),
  },
  other: {
    label: 'other',
    color: '#4E7090',   // cat.ocean — instruments/harmonic
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="7" cy="7" r="5"/>
        <path d="M7 4 L8.5 6.5 L11 7 L8.5 7.5 L7 10 L5.5 7.5 L3 7 L5.5 6.5 Z"/>
      </svg>
    ),
  },
}

const STEM_ORDER: StemKind[] = ['drums', 'bass', 'vocals', 'other']

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  stems: Record<StemKind, StemState>
  onMute:   (kind: StemKind, muted: boolean) => void
  onSolo:   (kind: StemKind, soloed: boolean) => void
  onGain:   (kind: StemKind, gainDb: number) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StemPanel({ stems, onMute, onSolo, onGain }: Props): JSX.Element {
  const anySoloed = STEM_ORDER.some((k) => stems[k].soloed)

  return (
    <div
      className="shrink-0 border-t px-2 py-1.5 space-y-0.5"
      style={{ borderColor: 'rgba(110,101,83,0.3)', background: 'rgba(14,11,8,0.35)' }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-[8px] uppercase tracking-[0.18em] font-bold"
          style={{ color: 'rgba(110,101,83,0.7)' }}
        >
          stem buses · mock
        </span>
        <span
          className="text-[7px] font-mono"
          style={{ color: 'rgba(110,101,83,0.35)' }}
        >
          engine phase 4
        </span>
      </div>

      {STEM_ORDER.map((kind) => {
        const meta  = STEM_META[kind]
        const state = stems[kind]
        const isActive = !state.muted && (!anySoloed || state.soloed)

        return (
          <StemRow
            key={kind}
            kind={kind}
            meta={meta}
            state={state}
            isActive={isActive}
            anySoloed={anySoloed}
            onMute={onMute}
            onSolo={onSolo}
            onGain={onGain}
          />
        )
      })}
    </div>
  )
}

// ── StemRow ───────────────────────────────────────────────────────────────────

interface RowProps {
  kind: StemKind
  meta: StemMeta
  state: StemState
  isActive: boolean
  anySoloed: boolean
  onMute:   (kind: StemKind, muted: boolean) => void
  onSolo:   (kind: StemKind, soloed: boolean) => void
  onGain:   (kind: StemKind, gainDb: number) => void
}

function StemRow({ kind, meta, state, isActive, onMute, onSolo, onGain }: RowProps): JSX.Element {
  // Corner-LED colours: active = accent glow, inactive = dim border
  const ledActive   = { background: 'rgb(216,106,74)', boxShadow: '0 0 5px rgba(216,106,74,0.7)' }
  const ledInactive = { background: 'rgba(110,101,83,0.3)' }

  return (
    <div className="flex items-center gap-1.5 h-7">

      {/* Colour blip */}
      <span
        className="shrink-0 w-2 h-2 rounded-sm"
        style={{
          background: meta.color,
          opacity: isActive ? 1 : 0.3,
          boxShadow: isActive ? `0 0 4px ${meta.color}66` : 'none',
          transition: 'opacity 0.15s, box-shadow 0.15s',
        }}
      />

      {/* Icon + label */}
      <div
        className="shrink-0 w-16 flex items-center gap-1"
        style={{ color: isActive ? 'rgba(235,229,211,0.75)' : 'rgba(110,101,83,0.45)', transition: 'color 0.15s' }}
      >
        {meta.icon}
        <span className="text-[8px] uppercase tracking-[0.14em]">{meta.label}</span>
      </div>

      {/* MUTE — FN-BUS cell style */}
      <button
        onClick={() => onMute(kind, !state.muted)}
        title={state.muted ? 'Unmute' : 'Mute'}
        className="relative shrink-0 h-6 w-8 flex flex-col items-center justify-center rounded transition-colors"
        style={{
          background: state.muted ? 'rgba(216,106,74,0.12)' : 'rgba(42,36,28,0.4)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: state.muted ? 'rgba(216,106,74,0.4)' : 'rgba(42,36,28,0.6)',
        }}
      >
        {/* Corner LED */}
        <span
          className="absolute top-1 right-1 w-1 h-1 rounded-full"
          style={state.muted ? ledActive : ledInactive}
        />
        <span className="text-[7px] font-bold" style={{ color: state.muted ? 'rgba(216,106,74,0.9)' : 'rgba(110,101,83,0.6)' }}>M</span>
      </button>

      {/* SOLO — FN-BUS cell style */}
      <button
        onClick={() => onSolo(kind, !state.soloed)}
        title={state.soloed ? 'Unsolo' : 'Solo'}
        className="relative shrink-0 h-6 w-8 flex flex-col items-center justify-center rounded transition-colors"
        style={{
          background: state.soloed ? 'rgba(201,160,44,0.15)' : 'rgba(42,36,28,0.4)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: state.soloed ? 'rgba(201,160,44,0.5)' : 'rgba(42,36,28,0.6)',
        }}
      >
        {/* Corner LED */}
        <span
          className="absolute top-1 right-1 w-1 h-1 rounded-full"
          style={state.soloed
            ? { background: 'rgb(201,160,44)', boxShadow: '0 0 5px rgba(201,160,44,0.7)' }
            : ledInactive}
        />
        <span className="text-[7px] font-bold" style={{ color: state.soloed ? 'rgba(201,160,44,0.9)' : 'rgba(110,101,83,0.6)' }}>S</span>
      </button>

      {/* Gain slider */}
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <input
          type="range"
          min={-24}
          max={6}
          step={0.5}
          value={state.gainDb}
          onChange={(e) => onGain(kind, parseFloat(e.target.value))}
          onDoubleClick={() => onGain(kind, 0)}
          title={`Gain: ${state.gainDb >= 0 ? '+' : ''}${state.gainDb} dB · double-click to reset`}
          className="flex-1 h-0.5 cursor-pointer"
          style={{ accentColor: meta.color, opacity: isActive ? 1 : 0.35 }}
        />
        <span
          className="shrink-0 text-[7px] font-mono tabular-nums w-7 text-right"
          style={{ color: 'rgba(110,101,83,0.5)' }}
        >
          {state.gainDb === 0 ? '0' : state.gainDb > 0 ? `+${state.gainDb}` : state.gainDb}dB
        </span>
      </div>
    </div>
  )
}
