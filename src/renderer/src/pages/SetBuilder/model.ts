import type { Track, Playlist } from '@shared/types'
import { compatibilityScore } from '../../lib/compatibility'
import { audioSimilarity } from '../../lib/similarity'
import { formatDuration } from '../../lib/format'

// ── Constants ─────────────────────────────────────────────────────────────────

export type ViewMode = 'split' | 'swimlane' | 'timeline' | 'graph'

export const CHAPTER_COLORS = [
  '#3CA8A1', '#E05E3B', '#4E7090', '#C9A02C',
  '#874850', '#6E8059', '#B07A4E', '#7B61A8',
  '#4A9B6F', '#B86E72', '#5E8E87', '#C1743C',
]

// ── Intelligence types & helpers ──────────────────────────────────────────────

export interface ChapterProfile {
  bpmMin: number | null; bpmMax: number | null; bpmAvg: number | null
  energyMin: number | null; energyMax: number | null; energyAvg: number | null
  moodAvg: number | null
  keyCluster: string | null
  duration: number; trackCount: number
}

export interface Suggestion {
  track: Track
  seedScore: number    // compatibility against seed track
  fitScore: number     // compatibility against chapter centroid
  score: number        // combined (60/40)
}

export interface ArcTransition {
  score: number        // 0–1, higher = smoother
  energyDelta: number  // absolute energy difference between chapters
  bpmDelta: number     // absolute BPM difference
  moodDelta: number    // absolute mood difference (0–2 range)
  label: 'smooth' | 'ok' | 'rough'
  color: string
}

export function computeProfile(tracks: Track[]): ChapterProfile {
  const wb = tracks.filter((t) => t.bpm    != null)
  const we = tracks.filter((t) => t.energy != null)
  const wm = tracks.filter((t) => t.mood   != null)
  const keyCounts = new Map<string, number>()
  for (const t of tracks) if (t.key) keyCounts.set(t.key, (keyCounts.get(t.key) ?? 0) + 1)

  return {
    bpmAvg:     wb.length ? wb.reduce((s, t) => s + t.bpm!, 0)    / wb.length : null,
    bpmMin:     wb.length ? Math.min(...wb.map((t) => t.bpm!))     : null,
    bpmMax:     wb.length ? Math.max(...wb.map((t) => t.bpm!))     : null,
    energyAvg:  we.length ? we.reduce((s, t) => s + t.energy!, 0) / we.length : null,
    energyMin:  we.length ? Math.min(...we.map((t) => t.energy!))  : null,
    energyMax:  we.length ? Math.max(...we.map((t) => t.energy!))  : null,
    moodAvg:    wm.length ? wm.reduce((s, t) => s + t.mood!,   0) / wm.length : null,
    keyCluster: keyCounts.size ? [...keyCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null,
    duration:   tracks.reduce((s, t) => s + (t.durationSeconds ?? 0), 0),
    trackCount: tracks.length,
  }
}

/** How well a track fits an existing chapter (scored against its centroid) */
export function fitScore(track: Track, profile: ChapterProfile): number {
  const centroid = {
    bpm: profile.bpmAvg, energy: profile.energyAvg,
    key: profile.keyCluster, mood: profile.moodAvg,
  } as Track
  return compatibilityScore(track, centroid)
}

/** Score library tracks as suggestions for a chapter given a seed track */
export function buildSuggestions(
  seed: Track, allTracks: Track[], profile: ChapterProfile, excludeIds: Set<string>
): Suggestion[] {
  const centroid = {
    bpm: profile.bpmAvg, energy: profile.energyAvg,
    key: profile.keyCluster, mood: profile.moodAvg,
  } as Track

  // When audio embeddings exist, blend content similarity so suggestions
  // reflect how tracks actually *sound*, not just metadata. No-op otherwise.
  const libEmb = allTracks.map((t) => t.embedding).filter((e): e is number[] => !!e)

  return allTracks
    .filter((t) => !excludeIds.has(t.id))
    .map((t) => {
      const sScore = compatibilityScore(seed, t)
      const fScore = compatibilityScore(centroid, t)
      const base = 0.6 * sScore + 0.4 * fScore
      const aSim = audioSimilarity(seed.embedding, t.embedding, libEmb)
      const score = aSim == null ? base : 0.7 * base + 0.3 * aSim
      return { track: t, seedScore: sScore, fitScore: fScore, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
}

/** How smooth is the chapter-to-chapter transition? */
export function arcTransition(a: ChapterProfile, b: ChapterProfile): ArcTransition {
  const eDelta = (a.energyAvg != null && b.energyAvg != null)
    ? Math.abs(a.energyAvg - b.energyAvg) : 3
  const bDelta = (a.bpmAvg != null && b.bpmAvg != null)
    ? Math.abs(a.bpmAvg - b.bpmAvg) : 15
  const mDelta = (a.moodAvg != null && b.moodAvg != null)
    ? Math.abs(a.moodAvg - b.moodAvg) : 0.6   // neutral penalty when unknown

  const eScore = Math.max(0, 1 - eDelta / 5)
  const bScore = Math.max(0, 1 - bDelta / 20)
  const mScore = Math.max(0, 1 - mDelta / 1.5)
  const score  = 0.50 * eScore + 0.30 * bScore + 0.20 * mScore

  const label = score > 0.65 ? 'smooth' : score > 0.40 ? 'ok' : 'rough'
  const color  = score > 0.65 ? '#4A9B6F' : score > 0.40 ? '#C9A02C' : '#B86E72'
  return { score, energyDelta: eDelta, bpmDelta: bDelta, moodDelta: mDelta, label, color }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

export const fmt = formatDuration

export function fmtBpmRange(p: ChapterProfile): string {
  if (!p.bpmMin || !p.bpmMax) return '—'
  if (Math.round(p.bpmMin) === Math.round(p.bpmMax)) return `${Math.round(p.bpmAvg!)} bpm`
  return `${Math.round(p.bpmMin)}–${Math.round(p.bpmMax)}`
}

export function fmtEnergyRange(p: ChapterProfile): string {
  if (p.energyAvg == null) return '—'
  if (p.energyMin === p.energyMax) return `nrg ${p.energyMin}`
  return `nrg ${p.energyMin}–${p.energyMax}`
}

export function scoreColor(s: number): string {
  if (s >= 0.70) return '#4A9B6F'
  if (s >= 0.50) return '#C9A02C'
  return '#B86E72'
}

// ── ViewProps ─────────────────────────────────────────────────────────────────

export interface ViewProps {
  chapters:       Playlist[]
  chapterTracks:  Map<string, Track[]>
  profiles:       Map<string, ChapterProfile>
  activeChapterId: string | null
  seedTrack:      Track | null
  suggestions:    Suggestion[]
  onSelectChapter:   (id: string) => void
  onAddTracks:       (chapterId: string, trackIds: string[]) => Promise<void>
  onRemoveTrack:     (chapterId: string, trackId: string) => Promise<void>
  onMagicSort:       (chapterId: string) => Promise<void>
  onAiSequence:      (chapterId: string) => Promise<void>
  aiEnabled:         boolean
  aiSeqBusyId:       string | null
  onLoadA:           (t: Track) => void
  onSetSeed:         (track: Track | null) => void
  onRenameChapter:   (id: string, name: string) => Promise<void>
  onDeleteChapter:   (id: string) => Promise<void>
  isDraggingTracks:  boolean
  draggingTrackIds:  string[]
}

// ── SortField (TrackBrowserPanel) ─────────────────────────────────────────────

export type SortField = 'artist' | 'bpm' | 'key' | 'energy' | 'genre'
