/**
 * Automix decision model — pure scoring logic, no audio dependency.
 *
 * For each candidate transition (fromTrack → toTrack), computes a composite
 * confidence score from four factors:
 *   grid      — mean beat confidence in the incoming track's intro
 *   harmonic  — Camelot wheel compatibility
 *   tempo     — BPM proximity
 *   energy    — energy level continuity
 *
 * Three confidence bands:
 *   auto      (≥ 0.75) — blend cleanly, no intervention needed
 *   assisted  (0.45–0.74) — blend, but flag it: "watch this one"
 *   handback  (< 0.45) — give control back to the DJ with a clear reason
 *
 * Fully testable against mock data — no imports from the audio engine.
 */

import type { Track, AutoMixDecision, AutoMixBand, AutoMixScores } from '@shared/types'

// ── Camelot wheel ─────────────────────────────────────────────────────────────

/** Parse a Camelot key string (e.g. "8A", "11B") into { num, band }. */
function parseCamelot(key: string): { num: number; band: 'A' | 'B' } | null {
  const m = key.trim().toUpperCase().match(/^(\d{1,2})([AB])$/)
  if (!m) return null
  const num = parseInt(m[1])
  if (num < 1 || num > 12) return null
  return { num, band: m[2] as 'A' | 'B' }
}

/** Wrap a Camelot number into 1–12. */
function wrap(n: number): number { return ((n - 1 + 12) % 12) + 1 }

/**
 * Camelot harmonic compatibility score (0–1).
 *
 * Distance 0 (same key)             → 1.0
 * Distance 1 (adjacent / same num)  → 0.85
 * Distance 2                        → 0.60
 * Distance 3+                       → decays to 0.0 at distance 6
 */
function harmonicScore(fromKey: string | null, toKey: string | null): number {
  if (!fromKey || !toKey) return 0.6    // unknown — neutral fallback
  const from = parseCamelot(fromKey)
  const to   = parseCamelot(toKey)
  if (!from || !to) return 0.6

  // Same key
  if (from.num === to.num && from.band === to.band) return 1.0

  // Relative minor/major (same number, opposite band)
  if (from.num === to.num) return 0.85

  // Adjacent semitone (±1 on the wheel, same band)
  if (
    from.band === to.band &&
    (wrap(from.num + 1) === to.num || wrap(from.num - 1) === to.num)
  ) return 0.85

  // Calculate circular distance on the wheel (within-band)
  const dist = Math.min(
    Math.abs(from.num - to.num),
    12 - Math.abs(from.num - to.num)
  )
  // Cross-band penalty adds 1 effective step
  const effective = from.band !== to.band ? dist + 1 : dist

  return Math.max(0, 1 - effective * 0.18)
}

// ── Grid confidence ───────────────────────────────────────────────────────────

/**
 * Mean beat confidence across the first INTRO_BEATS beats of the track.
 * A low score here means "the beatgrid is uncertain at the intro" — a warning.
 * Falls back to 0.70 when no analysedBeatgrid is available (neutral/unknown).
 */
const INTRO_BEATS = 16

function gridScore(track: Track): number {
  const beats = track.analysedBeatgrid?.beats
  if (!beats || beats.length === 0) return 0.70
  const slice = beats.slice(0, INTRO_BEATS)
  return slice.reduce((s, b) => s + b.confidence, 0) / slice.length
}

// ── Tempo score ───────────────────────────────────────────────────────────────

/**
 * Linear BPM proximity. Falls to 0 at ≥ MAX_BPM_GAP difference.
 * If either BPM is unknown, returns a neutral score.
 */
const MAX_BPM_GAP = 20

function tempoScore(fromBpm: number | null, toBpm: number | null): number {
  if (!fromBpm || !toBpm) return 0.65
  return Math.max(0, 1 - Math.abs(fromBpm - toBpm) / MAX_BPM_GAP)
}

// ── Energy score ──────────────────────────────────────────────────────────────

/**
 * Energy continuity — decay over the full 1–10 range (9 points).
 * Large energy jumps are valid artistically but riskier for automix.
 */
function energyScore(fromEnergy: number | null, toEnergy: number | null): number {
  if (fromEnergy == null || toEnergy == null) return 0.70
  return Math.max(0, 1 - Math.abs(fromEnergy - toEnergy) / 9)
}

// ── Reason string ─────────────────────────────────────────────────────────────

/** Returns a short, honest explanation for why a transition scored as it did. */
function buildReason(
  band: AutoMixBand,
  scores: AutoMixScores,
  from: Track,
  to: Track
): string {
  if (band === 'auto') return 'clean blend — grid, key, tempo, and energy all look good'

  // Find the weakest factor(s)
  const parts: string[] = []
  if (scores.grid < 0.60)     parts.push(`uncertain grid in ${to.title || 'incoming track'}'s intro`)
  if (scores.harmonic < 0.50) parts.push('key clash')
  if (scores.tempo < 0.50) {
    const gap = Math.abs((from.bpm ?? 0) - (to.bpm ?? 0))
    parts.push(`${gap.toFixed(1)} BPM gap`)
  }
  if (scores.energy < 0.55) {
    const diff = Math.abs((from.energy ?? 5) - (to.energy ?? 5))
    parts.push(`${diff.toFixed(0)}-point energy jump`)
  }

  if (parts.length === 0) return 'moderate confidence — review before automixing'
  const prefix = band === 'handback' ? 'take this one — ' : 'watch — '
  return prefix + parts.join(', ')
}

// ── Weights ───────────────────────────────────────────────────────────────────

const W_GRID     = 0.35
const W_HARMONIC = 0.35
const W_TEMPO    = 0.20
const W_ENERGY   = 0.10

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score a transition between two consecutive tracks.
 * Pure function — deterministic given the same inputs.
 */
export function scoreTransition(from: Track, to: Track): AutoMixDecision {
  const grid     = gridScore(to)
  const harmonic = harmonicScore(from.key, to.key)
  const tempo    = tempoScore(from.bpm, to.bpm)
  const energy   = energyScore(from.energy, to.energy)

  const scores: AutoMixScores = { grid, harmonic, tempo, energy }
  const confidence = W_GRID * grid + W_HARMONIC * harmonic + W_TEMPO * tempo + W_ENERGY * energy

  const band: AutoMixBand =
    confidence >= 0.75 ? 'auto' :
    confidence >= 0.45 ? 'assisted' :
    'handback'

  return {
    fromTrackId: from.id,
    toTrackId:   to.id,
    confidence,
    band,
    reason: buildReason(band, scores, from, to),
    scores,
  }
}

/**
 * Score all consecutive transitions in a running order.
 * Returns a map keyed by `fromTrackId`.
 */
export function scoreOrder(tracks: Track[]): Map<string, AutoMixDecision> {
  const map = new Map<string, AutoMixDecision>()
  for (let i = 0; i < tracks.length - 1; i++) {
    const decision = scoreTransition(tracks[i], tracks[i + 1])
    map.set(tracks[i].id, decision)
  }
  return map
}

// ── Band display helpers ──────────────────────────────────────────────────────

export const BAND_LABEL: Record<AutoMixBand, string> = {
  auto:      'AUTO',
  assisted:  'WATCH',
  handback:  'TAKE',
}

export const BAND_GLYPH: Record<AutoMixBand, string> = {
  auto:     '●',
  assisted: '◐',
  handback: '↩',
}

/** CSS colour for each band. */
export const BAND_COLOR: Record<AutoMixBand, string> = {
  auto:     '#4ade80',             // green
  assisted: '#f59e0b',             // amber
  handback: '#D86A4A',             // terracotta
}

export const BAND_BG: Record<AutoMixBand, string> = {
  auto:     'rgba(74,222,128,0.12)',
  assisted: 'rgba(245,158,11,0.12)',
  handback: 'rgba(216,106,74,0.12)',
}

export const BAND_BORDER: Record<AutoMixBand, string> = {
  auto:     'rgba(74,222,128,0.35)',
  assisted: 'rgba(245,158,11,0.35)',
  handback: 'rgba(216,106,74,0.35)',
}
