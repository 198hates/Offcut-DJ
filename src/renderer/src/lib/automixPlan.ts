// Pure planning helpers for automix execution. The imperative controller
// (automixController.ts) drives the decks/engine/mixer; everything here is
// side-effect-free and unit-tested so the timing/curve maths stay correct.

import type { AutoMixBand, CuePoint, Track } from '@shared/types'
import { scoreTransition } from './automix'

/**
 * How many bars the blend should run for, by transition confidence. A clean
 * "auto" blend gets the full length; an "assisted" one is shorter (less time
 * with two imperfect tracks audible); a "handback" is a quick cut.
 */
export function transitionBarsForBand(band: AutoMixBand, baseBars: number): number {
  switch (band) {
    case 'auto':
      return baseBars
    case 'assisted':
      return Math.max(8, Math.round(baseBars / 2))
    case 'handback':
      return 4
  }
}

/** Milliseconds for `bars` bars of 4/4 at `bpm`. Falls back to 128 BPM. */
export function barsToMs(bars: number, bpm: number | null | undefined): number {
  const b = bpm && bpm > 0 ? bpm : 128
  return bars * 4 * (60000 / b)
}

/** Smoothstep easing (0→1, flat at both ends) for a click-free fader sweep. */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * Crossfader position partway through a transition. `fromX`/`toX` are the
 * start/end xfade values (0 = deck A only, 1 = deck B only); the master side is
 * the `from`, the incoming side the `to`. Eased so the blend has no hard edges.
 */
export function crossfadeAt(elapsedMs: number, durationMs: number, fromX: number, toX: number): number {
  if (durationMs <= 0) return toX
  const t = smoothstep(elapsedMs / durationMs)
  return fromX + (toX - fromX) * t
}

/** The xfade value that isolates a deck (A → 0, B → 1). */
export function xfadeForDeck(deck: 'A' | 'B'): number {
  return deck === 'A' ? 0 : 1
}

/**
 * Where to start the incoming track (ms). Prefer a cue that reads like an
 * intro / mix-in marker; otherwise start at the top. Keeps the incoming track's
 * intro under the outgoing track's outro for a natural blend.
 */
export function entryCueMs(track: Pick<Track, 'cuePoints'>): number {
  const cues = (track.cuePoints ?? []).filter((c: CuePoint) => c.type === 'hotcue')
  const mixIn = cues.find((c) => /mix|intro|\bin\b/i.test(c.label))
  if (mixIn) return Math.max(0, mixIn.positionMs)
  return 0
}

// ── Transition styles ─────────────────────────────────────────────────────────
// A style is a timeline over the blend window (t: 0→1) that drives the
// crossfader plus per-deck EQ / filter / delay. The pure frame is mapped onto
// the real decks by the controller (which deck is master, what the delay time
// is). Mirrors djay's "Crossfader Fusion" presets — fade / cut / EQ bass-swap /
// echo-out / filter — all expressible with the engine's existing EQ + new FX.

/** Concrete transition styles the controller can run. */
export type TransitionStyle = 'fade' | 'cut' | 'eqBassSwap' | 'echoOut' | 'filter'
/** User-facing selection — 'auto' resolves to a concrete style per transition. */
export type TransitionStyleChoice = TransitionStyle | 'auto'

/** Per-deck effect state at a point in the transition. dB for EQ (0 = flat,
 *  −24 = kill); filter −1..+1; delay is a wet send. */
export interface DeckFx {
  eqLow: number
  eqMid: number
  eqHigh: number
  filter: number
  delayMix: number
  delayFeedback: number
  delayEnabled: boolean
}

export interface TransitionFrame {
  /** 0 = fully outgoing, 1 = fully incoming (controller maps to A/B). */
  xfadeOutToIn: number
  outgoing: DeckFx
  incoming: DeckFx
}

const NEUTRAL_FX: DeckFx = {
  eqLow: 0, eqMid: 0, eqHigh: 0, filter: 0, delayMix: 0, delayFeedback: 0.4, delayEnabled: false
}
const fx = (over: Partial<DeckFx>): DeckFx => ({ ...NEUTRAL_FX, ...over })

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const EQ_KILL_DB = -24

/**
 * Resolve a user choice to a concrete style. 'auto' picks by transition
 * confidence: a clean blend gets an EQ bass-swap, a so-so one a filter sweep,
 * and a rough one an echo-out to mask the seam (mirrors djay's shuffle, but
 * musically targeted).
 */
export function resolveTransitionStyle(choice: TransitionStyleChoice, band: AutoMixBand): TransitionStyle {
  if (choice !== 'auto') return choice
  switch (band) {
    case 'auto': return 'eqBassSwap'
    case 'assisted': return 'filter'
    case 'handback': return 'echoOut'
  }
}

/** The transition frame for `style` at progress `t` (0→1). Pure. */
export function transitionFrameAt(style: TransitionStyle, t: number): TransitionFrame {
  const s = smoothstep(t)
  switch (style) {
    case 'fade':
      return { xfadeOutToIn: s, outgoing: NEUTRAL_FX, incoming: NEUTRAL_FX }

    case 'cut':
      // Stay fully on the outgoing track, then switch on the final beat.
      return { xfadeOutToIn: t < 0.97 ? 0 : 1, outgoing: NEUTRAL_FX, incoming: NEUTRAL_FX }

    case 'eqBassSwap': {
      // Blend across, but hand the bass over quickly around the midpoint so two
      // kicks never play together: outgoing low drops to kill, incoming low rises.
      const swap = smoothstep(clamp01((t - 0.4) / 0.2))
      return {
        xfadeOutToIn: s,
        outgoing: fx({ eqLow: lerp(0, EQ_KILL_DB, swap) }),
        incoming: fx({ eqLow: lerp(EQ_KILL_DB, 0, swap) })
      }
    }

    case 'echoOut': {
      // Quick mix to the incoming track (reach it by the halfway point) while the
      // outgoing track feeds a feedback echo that rings off into the distance.
      const mixIn = smoothstep(clamp01(t / 0.5))
      const wet = smoothstep(clamp01(t / 0.4))
      return {
        xfadeOutToIn: mixIn,
        outgoing: fx({ delayEnabled: true, delayFeedback: 0.55, delayMix: lerp(0, 0.6, wet) }),
        incoming: NEUTRAL_FX
      }
    }

    case 'filter':
      // High-pass the outgoing track up and out (its lows thin away as it leaves)
      // while the incoming track comes in clean under a full crossfade.
      return {
        xfadeOutToIn: s,
        outgoing: fx({ filter: s }),
        incoming: NEUTRAL_FX
      }
  }
}

/**
 * Pick the most compatible next track from a pool for an auto-selecting mix —
 * highest transition confidence (grid · key · tempo · energy) from `current`,
 * excluding the current track and anything already played. Tracks without a BPM
 * are skipped (the scorer and beat-sync need one). Returns null when the pool is
 * exhausted. Ties resolve to the earlier pool entry (deterministic).
 */
export function pickNextTrack(current: Track, pool: Track[], playedIds: Set<string>): Track | null {
  let best: Track | null = null
  let bestScore = -1
  for (const t of pool) {
    if (t.id === current.id || playedIds.has(t.id) || t.bpm == null) continue
    const score = scoreTransition(current, t).confidence
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  return best
}
