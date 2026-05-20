import type { Track, BeatgridMarker } from '@shared/types'

// ── Camelot distance ──────────────────────────────────────────────────────────
// Keys are "1A"–"12A" (minor) and "1B"–"12B" (major).
// Distance measures how harmonically compatible two keys are.
//   0 = same key
//   1 = relative major/minor or one step around the wheel
//   2 = two steps
//   ...
// Returns a value 0–6 (max meaningful distance on the wheel).

export function camelotDistance(a: string | null, b: string | null): number {
  if (!a || !b) return 3   // unknown = neutral mid-range penalty
  const mA = a.toUpperCase().match(/^(\d{1,2})([AB])$/)
  const mB = b.toUpperCase().match(/^(\d{1,2})([AB])$/)
  if (!mA || !mB) return 3

  const nA = parseInt(mA[1]), lA = mA[2]
  const nB = parseInt(mB[1]), lB = mB[2]

  // Circular numeric distance (1–12 wheel)
  const numDist = Math.min(Math.abs(nA - nB), 12 - Math.abs(nA - nB))
  const letterDist = lA === lB ? 0 : 1

  return numDist + letterDist
}

// Harmonic compatibility 0–1 (1 = same key, decays by 0.2 per Camelot step)
export function harmonicScore(a: string | null, b: string | null): number {
  return Math.max(0.1, 1 - camelotDistance(a, b) * 0.2)
}

// ── Compatibility score ───────────────────────────────────────────────────────
// Weighted combination of harmonic, energy, and BPM compatibility.
// Returns 0–1 (1 = perfectly compatible).

export function compatibilityScore(a: Track, b: Track): number {
  const harmonic = harmonicScore(a.key, b.key)

  const energy =
    a.energy != null && b.energy != null
      ? 1 - Math.min(1, Math.abs(a.energy - b.energy) / 5)
      : 0.5

  const bpm =
    a.bpm != null && b.bpm != null
      ? 1 - Math.min(1, Math.abs(a.bpm - b.bpm) / 30)
      : 0.5

  return 0.45 * harmonic + 0.35 * energy + 0.20 * bpm
}

// ── Magic Sort ────────────────────────────────────────────────────────────────
// Greedy nearest-neighbour ordering of a track list by compatibility.
// Seeds from the highest-energy track, then always picks the unvisited track
// with the best compatibility score against the last placed track.

export interface MagicSortResult {
  sorted: Track[]
  flagged: Set<string>   // track IDs where the preceding transition scores below threshold
}

const HARD_TRANSITION_THRESHOLD = 0.40

export function magicSort(tracks: Track[]): MagicSortResult {
  if (tracks.length <= 1) return { sorted: tracks.slice(), flagged: new Set() }

  const used   = new Set<string>()
  const result: Track[] = []

  // Seed: highest-energy track (or first track if no energy data)
  const withEnergy = tracks.filter((t) => t.energy != null)
  const seed =
    withEnergy.length > 0
      ? [...withEnergy].sort((a, b) => (b.energy ?? 0) - (a.energy ?? 0))[0]
      : tracks[0]

  result.push(seed)
  used.add(seed.id)

  while (result.length < tracks.length) {
    const last = result[result.length - 1]
    let bestScore = -1
    let bestTrack: Track | null = null

    for (const candidate of tracks) {
      if (used.has(candidate.id)) continue
      const score = compatibilityScore(last, candidate)
      if (score > bestScore) {
        bestScore = score
        bestTrack = candidate
      }
    }

    if (!bestTrack) break
    result.push(bestTrack)
    used.add(bestTrack.id)
  }

  // Append anything that wasn't reached (shouldn't happen with connected graph)
  for (const t of tracks) {
    if (!used.has(t.id)) result.push(t)
  }

  // Flag transitions that fall below the hard-transition threshold
  const flagged = new Set<string>()
  for (let i = 1; i < result.length; i++) {
    if (compatibilityScore(result[i - 1], result[i]) < HARD_TRANSITION_THRESHOLD) {
      flagged.add(result[i].id)
    }
  }

  return { sorted: result, flagged }
}

// ── Beatgrid generation ───────────────────────────────────────────────────────
// Generates a uniform-tempo beatgrid from BPM + first-beat offset.
// Used both by BeatgridEditor and as a live fallback in the player when a
// track has BPM data but no stored markers.

export function generateBeatgrid(bpm: number, offsetMs: number, durationMs: number): BeatgridMarker[] {
  if (bpm <= 0 || durationMs <= 0) return []
  const beatMs = 60000 / bpm
  // Normalise offset to [0, beatMs)
  let t = offsetMs % beatMs
  if (t < 0) t += beatMs

  const markers: BeatgridMarker[] = []
  let beatIdx = 0
  while (t <= durationMs + beatMs) {
    markers.push({ positionMs: t, bpm, isDownbeat: beatIdx % 4 === 0 })
    t += beatMs
    beatIdx++
  }
  return markers
}
