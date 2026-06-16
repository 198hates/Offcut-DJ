/**
 * roadNotTaken.ts — "The Road Not Taken" local library scorer
 *
 * Phase 2 of id·2026·013.
 *
 * Given a moment in a set (BPM, key, energy at a transition point),
 * scores every owned track in the library on how well it would have
 * slotted in — entirely local, zero external dependencies.
 *
 * Scoring factors (v1 — no audio embeddings yet):
 *   harmonic   35 % — Camelot wheel compatibility
 *   tempo      30 % — BPM proximity (Gaussian, half/double-time aware)
 *   energy     20 % — Energy level proximity
 *   freshness  15 % — Inverse recency (stale tracks get a revival bonus)
 */

import type { Track } from '@shared/types'
import { harmonicScore } from './compatibility'
import { audioSimilarity } from './similarity'

// ── Public types ──────────────────────────────────────────────────────────────

/** The set's state at a specific transition moment */
export interface MomentContext {
  bpm:       number | null
  key:       string | null
  energy:    number | null
  /** Reference audio embedding for content similarity (optional). */
  embedding?: number[] | null
  /** All track IDs already in the running order — these are excluded */
  playedIds: Set<string>
}

export interface RntScores {
  harmonic:  number   // 0–1
  tempo:     number   // 0–1
  energy:    number   // 0–1
  freshness: number   // 0–1
  audio?:    number   // 0–1, present only when embeddings exist
}

export interface RntCandidate {
  track:      Track
  totalScore: number  // 0–1 weighted composite
  scores:     RntScores
  reason:     string  // human-readable explanation
}

// ── Factor weights ─────────────────────────────────────────────────────────────

const W = { harmonic: 0.35, tempo: 0.30, energy: 0.20, freshness: 0.15 } as const

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Gaussian: 1.0 at center, decays symmetrically */
function gauss(x: number, center: number, sigma: number): number {
  return Math.exp(-0.5 * ((x - center) / sigma) ** 2)
}

/**
 * Tempo score: Gaussian centred at 0% BPM difference (σ = 8%).
 * Also considers half-time and double-time as near-identical (common in DJ mixing).
 */
function tempoScore(trackBpm: number | null, ctxBpm: number | null): number {
  if (!trackBpm || !ctxBpm) return 0.50
  const ratio   = Math.abs(trackBpm         - ctxBpm) / ctxBpm
  const half    = Math.abs(trackBpm * 2     - ctxBpm) / ctxBpm
  const dbl     = Math.abs(trackBpm / 2     - ctxBpm) / ctxBpm
  return gauss(Math.min(ratio, half, dbl), 0, 0.08)
}

/** Energy score: Gaussian centred on context energy (σ = 2 points on 1–10 scale) */
function energyScore(trackE: number | null, ctxE: number | null): number {
  if (trackE == null || ctxE == null) return 0.50
  return gauss(trackE, ctxE, 2.0)
}

/**
 * Freshness score: 1 = long since played / never played (excellent to revive),
 * 0 = played in the last few days (heavy-rotation penalty).
 */
function freshnessScore(track: Track): number {
  if (track.playCount === 0 || !track.lastPlayedAt) return 0.70  // never played
  const days = (Date.now() - new Date(track.lastPlayedAt).getTime()) / 86_400_000
  if (days > 180) return 1.00   // 6 months+ → rediscovery
  if (days > 90)  return 0.85   // 3–6 months
  if (days > 30)  return 0.65   // 1–3 months
  if (days > 7)   return 0.40   // 1–4 weeks
  return 0.10                   // < 1 week → heavy rotation
}

/** Human-readable reason summarising why the track was surfaced */
function buildReason(track: Track, ctx: MomentContext, s: RntScores): string {
  const parts: string[] = []

  // Key / harmony
  if (s.harmonic >= 0.80 && track.key && ctx.key)
    parts.push(`${track.key} · harmonic`)
  else if (s.harmonic >= 0.50 && track.key)
    parts.push(`${track.key} · compatible`)

  // Tempo
  if (track.bpm && ctx.bpm) {
    const delta = track.bpm - ctx.bpm
    if (Math.abs(delta) < 1)
      parts.push(`${track.bpm.toFixed(0)} bpm`)
    else
      parts.push(`${track.bpm.toFixed(0)} bpm (${delta > 0 ? '+' : ''}${delta.toFixed(0)})`)
  }

  // Energy
  if (s.energy >= 0.80 && track.energy != null)
    parts.push(`energy ${track.energy}`)
  else if (track.energy != null && ctx.energy != null) {
    const eDelta = track.energy - ctx.energy
    if (Math.abs(eDelta) >= 1)
      parts.push(`energy ${track.energy} (${eDelta > 0 ? '+' : ''}${eDelta})`)
  }

  // Freshness
  if (s.freshness >= 0.85) {
    if (!track.lastPlayedAt || track.playCount === 0) {
      parts.push('never played')
    } else {
      const months = Math.round(
        (Date.now() - new Date(track.lastPlayedAt).getTime()) / (30 * 86_400_000)
      )
      parts.push(`${months}m out of rotation`)
    }
  } else if (s.freshness <= 0.15) {
    parts.push('heavy rotation')
  }

  return parts.join(' · ') || 'general fit'
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score all tracks in the library against a moment context.
 * Tracks in `context.playedIds` are excluded (they're already in the set).
 * Returns up to `limit` candidates sorted by descending totalScore.
 */
export function scoreLibrary(
  tracks: Track[],
  context: MomentContext,
  limit = 8
): RntCandidate[] {
  const results: RntCandidate[] = []
  const libEmb = tracks.map((t) => t.embedding).filter((e): e is number[] => !!e)

  for (const track of tracks) {
    if (context.playedIds.has(track.id)) continue

    const scores: RntScores = {
      harmonic:  harmonicScore(track.key, context.key),
      tempo:     tempoScore(track.bpm, context.bpm),
      energy:    energyScore(track.energy, context.energy),
      freshness: freshnessScore(track),
    }

    const base =
      W.harmonic  * scores.harmonic  +
      W.tempo     * scores.tempo     +
      W.energy    * scores.energy    +
      W.freshness * scores.freshness

    // Nudge by audio-content similarity when embeddings are present.
    const aSim = audioSimilarity(context.embedding, track.embedding, libEmb)
    if (aSim != null) scores.audio = aSim
    const totalScore = aSim == null ? base : 0.8 * base + 0.2 * aSim

    results.push({ track, totalScore, scores, reason: buildReason(track, context, scores) })
  }

  return results
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, limit)
}

/**
 * Derive a moment context from the boundary between two adjacent tracks.
 * `from` is the outgoing track, `to` is the incoming track.
 * Either can be null (opening slot or closing slot).
 *
 * The context targets the incoming track's key / energy (what we're mixing *into*),
 * and the average BPM (where the blend happens).
 */
export function transitionContext(
  from: Track | null,
  to:   Track | null,
  playedIds: Set<string>
): MomentContext {
  const bpm =
    from?.bpm != null && to?.bpm != null ? (from.bpm + to.bpm) / 2
    : to?.bpm ?? from?.bpm ?? null

  return {
    bpm,
    key:       to?.key       ?? from?.key       ?? null,
    energy:    to?.energy    ?? from?.energy    ?? null,
    embedding: to?.embedding ?? from?.embedding ?? null,
    playedIds,
  }
}
