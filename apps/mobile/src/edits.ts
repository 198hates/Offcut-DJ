// Prep-edit helpers for slice 3 (two-way edits pushed to the desktop).
//
// Palettes mirror the desktop (TrackDetail TRACK_COLORS, playerStore
// HOT_CUE_COLORS/LABELS) so a colour set on the phone reads identically there.
//
// IMPORTANT: the phone must never push `beatgrid`/`analysedBeatgrid` — the lean
// mirror strips them (see desktop leanTrack), so the phone holds empty grids and
// sending them would wipe the desktop's real grids. Only the fields below ship.

import type { CuePoint, Track, TrackPatch } from './sync-types'

export const TRACK_COLORS = [
  '#6E8059', '#4E7090', '#B07A4E', '#C9A02C',
  '#B86E72', '#874850', '#8E8473', '#B84A2B'
]

export const HOT_CUE_COLORS = [
  '#e91e63', '#ff9800', '#ffeb3b', '#4caf50',
  '#00bcd4', '#2196f3', '#9c27b0', '#f44336'
]
export const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/** Mood is a −1 (dark) → +1 (uplifting) float; the phone edits it in steps. */
export const MOOD_STEPS = [-1, -0.5, 0, 0.5, 1]

/** The slice-3 editable surface — a local draft of a track's prep fields. */
export interface Draft {
  rating: number
  energy: number | null
  mood: number | null
  color: string
  comment: string
  tags: string[]
  cuePoints: CuePoint[]
}

export function draftFromTrack(t: Track): Draft {
  return {
    rating: t.rating ?? 0,
    energy: t.energy ?? null,
    mood: t.mood ?? null,
    color: t.color ?? '',
    comment: t.comment ?? '',
    tags: [...(t.tags ?? [])],
    cuePoints: (t.cuePoints ?? []).map((c) => ({ ...c }))
  }
}

function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * Diff a draft against the track it came from, returning a TrackPatch carrying
 * only the changed fields (plus id + a fresh updatedAt). Returns null when
 * nothing changed. cuePoints are compared by value (JSON) — small arrays.
 */
export function buildPatch(track: Track, draft: Draft, nowIso: string): TrackPatch | null {
  const patch: TrackPatch = { id: track.id, updatedAt: nowIso }
  let changed = false
  if (draft.rating !== (track.rating ?? 0)) { patch.rating = draft.rating; changed = true }
  if (draft.energy !== (track.energy ?? null)) { patch.energy = draft.energy; changed = true }
  if (draft.mood !== (track.mood ?? null)) { patch.mood = draft.mood; changed = true }
  if (draft.color !== (track.color ?? '')) { patch.color = draft.color; changed = true }
  if (draft.comment !== (track.comment ?? '')) { patch.comment = draft.comment; changed = true }
  if (!tagsEqual(draft.tags, track.tags ?? [])) { patch.tags = draft.tags; changed = true }
  if (JSON.stringify(draft.cuePoints) !== JSON.stringify(track.cuePoints ?? [])) {
    patch.cuePoints = draft.cuePoints
    changed = true
  }
  // contentHash lets the desktop reconcile if ids ever diverge; harmless to omit.
  return changed ? patch : null
}

/** The patch fields as a partial Track, for an optimistic local merge. */
export function patchAsTrackFields(patch: TrackPatch): Partial<Track> {
  const { id: _id, contentHash: _ch, ...rest } = patch
  return rest as Partial<Track>
}

export function hotCues(cues: CuePoint[]): CuePoint[] {
  return cues.filter((c) => c.type === 'hotcue').sort((a, b) => a.index - b.index)
}

/** Lowest free hot-cue slot 0..7, or -1 when all eight are taken. */
function freeHotCueSlot(cues: CuePoint[]): number {
  const used = new Set(hotCues(cues).map((c) => c.index))
  for (let i = 0; i < HOT_CUE_LABELS.length; i++) if (!used.has(i)) return i
  return -1
}

/** Add a hot cue at positionMs using the next free slot. No-op if all taken. */
export function addHotCue(cues: CuePoint[], positionMs: number): CuePoint[] {
  const slot = freeHotCueSlot(cues)
  if (slot < 0) return cues
  const cue: CuePoint = {
    index: slot,
    type: 'hotcue',
    positionMs: Math.max(0, Math.round(positionMs)),
    color: HOT_CUE_COLORS[slot % HOT_CUE_COLORS.length],
    label: HOT_CUE_LABELS[slot]
  }
  return [...cues, cue].sort((a, b) => a.positionMs - b.positionMs)
}

/** Remove the hot cue in a given slot. */
export function removeHotCue(cues: CuePoint[], index: number): CuePoint[] {
  return cues.filter((c) => !(c.type === 'hotcue' && c.index === index))
}
