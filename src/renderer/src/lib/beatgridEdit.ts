// Pure grid-construction for the Beatgrid editor. Kept out of the component so
// the maths (single anchor vs. a mid-track re-anchor) is unit-tested.

import type { BeatgridMarker } from '@shared/types'
import { generateBeatgrid } from './compatibility'

/** Re-flag downbeats so bar 1 falls on beat `phase` (0–3) of every 4, without
 *  moving the beats themselves. */
export function withDownbeatPhase(markers: BeatgridMarker[], phase: number): BeatgridMarker[] {
  const p = ((phase % 4) + 4) % 4
  return markers.map((m, i) => ({ ...m, isDownbeat: i % 4 === p }))
}

/** A uniform grid aligned so a beat (the musical "1") lands exactly on
 *  `anchorMs`, with the downbeat phase derived from that anchor. */
export function gridForAnchor(bpm: number, durationMs: number, anchorMs: number): BeatgridMarker[] {
  const beatMs = 60000 / bpm
  const offsetMs = ((anchorMs % beatMs) + beatMs) % beatMs
  const phase = ((Math.round((anchorMs - offsetMs) / beatMs) % 4) + 4) % 4
  return withDownbeatPhase(generateBeatgrid(bpm, offsetMs, durationMs), phase)
}

/**
 * The full editor grid. With a re-anchor, every beat at/after `anchor2Ms` is
 * re-phased to that second downbeat — a remix re-drop after a middle-8 that
 * isn't a whole number of bars — producing one phase discontinuity at the seam.
 * A single global BPM+offset can't represent that; this can.
 */
export function buildGridMarkers(
  bpm: number,
  durationMs: number,
  anchor1Ms: number,
  anchor2Ms: number | null
): BeatgridMarker[] {
  if (anchor2Ms == null) return gridForAnchor(bpm, durationMs, anchor1Ms)
  const seam = Math.max(0, anchor2Ms)
  const head = gridForAnchor(bpm, durationMs, anchor1Ms).filter((m) => m.positionMs < seam)
  const tail = gridForAnchor(bpm, durationMs, anchor2Ms).filter((m) => m.positionMs >= seam)
  return [...head, ...tail]
}
