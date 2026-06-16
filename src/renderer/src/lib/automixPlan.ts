// Pure planning helpers for automix execution. The imperative controller
// (automixController.ts) drives the decks/engine/mixer; everything here is
// side-effect-free and unit-tested so the timing/curve maths stay correct.

import type { AutoMixBand, CuePoint, Track } from '@shared/types'

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
