import type { Track } from '@shared/types'

// ── Feature vector ────────────────────────────────────────────────────────────
// 5 dimensions, each pre-weighted so Euclidean distance reflects musical
// compatibility: BPM proximity matters most, then harmonic key, then energy.
//
//   [0] bpm_norm   × 0.45  — BPM normalised to [60,200]→[0,1]
//   [1] key_x      × 0.20  — Camelot wheel x (cosine component)
//   [2] key_y      × 0.20  — Camelot wheel y (sine component)
//   [3] key_mode   × 0.08  — 0=minor(A) / 1=major(B)
//   [4] energy_n   × 0.07  — energy 1–10 normalised to [0,1]
//
// Unknown fields default to 0.5 (centre of each range).

function camelotToCircle(key: string | null): [number, number, number] {
  if (!key) return [0, 0, 0.5]
  const m = key.toUpperCase().match(/^(\d{1,2})([AB])$/)
  if (!m) return [0, 0, 0.5]
  const num   = parseInt(m[1]) - 1   // 0–11
  const angle = (2 * Math.PI * num) / 12
  const mode  = m[2] === 'B' ? 1 : 0
  return [Math.cos(angle), Math.sin(angle), mode]
}

export function featureVec(t: Track): Float32Array {
  const bpm    = t.bpm    != null ? Math.max(0, Math.min(1, (t.bpm - 60) / 140)) : 0.5
  const energy = t.energy != null ? (t.energy - 1) / 9                            : 0.5
  const [kx, ky, km] = camelotToCircle(t.key)
  return new Float32Array([
    bpm    * 0.45,
    kx     * 0.20,
    ky     * 0.20,
    km     * 0.08,
    energy * 0.07,
  ])
}

function dist(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d }
  return Math.sqrt(s)
}

// ── DBSCAN ────────────────────────────────────────────────────────────────────

export interface ClusterResult {
  clusters: Track[][]   // each inner array is one cluster, sorted largest first
  noise: Track[]        // tracks that didn't fit any cluster
}

export function dbscan(
  tracks: Track[],
  epsilon = 0.15,
  minPts  = Math.max(5, Math.floor(tracks.length / 100)),
): ClusterResult {
  // Only cluster tracks that have at least BPM (key + energy improve grouping
  // but aren't required — the feature vec uses 0.5 defaults for missing fields)
  const eligible = tracks.filter((t) => t.bpm != null)
  if (eligible.length < minPts * 2) return { clusters: [], noise: tracks.slice() }

  const vecs     = eligible.map(featureVec)
  const label    = new Int32Array(eligible.length).fill(-1)  // -1 = unvisited
  const NOISE    = -2
  let   clusterId = 0

  const rangeQuery = (idx: number): number[] => {
    const result: number[] = []
    const va = vecs[idx]
    for (let j = 0; j < eligible.length; j++) {
      if (dist(va, vecs[j]) <= epsilon) result.push(j)
    }
    return result
  }

  for (let i = 0; i < eligible.length; i++) {
    if (label[i] !== -1) continue
    const neighbours = rangeQuery(i)
    if (neighbours.length < minPts) { label[i] = NOISE; continue }

    label[i] = clusterId
    const seeds = neighbours.filter((n) => n !== i)

    for (let si = 0; si < seeds.length; si++) {
      const q = seeds[si]
      if (label[q] === NOISE) label[q] = clusterId
      if (label[q] !== -1) continue
      label[q] = clusterId
      const qNeighbours = rangeQuery(q)
      if (qNeighbours.length >= minPts) {
        for (const n of qNeighbours) {
          if (!seeds.includes(n)) seeds.push(n)
        }
      }
    }
    clusterId++
  }

  // Gather results
  const clusterMap = new Map<number, Track[]>()
  const noise: Track[] = []

  for (let i = 0; i < eligible.length; i++) {
    if (label[i] === NOISE || label[i] === -1) { noise.push(eligible[i]); continue }
    const arr = clusterMap.get(label[i]) ?? []
    arr.push(eligible[i])
    clusterMap.set(label[i], arr)
  }

  // Include ineligible tracks as noise
  const eligibleIds = new Set(eligible.map((t) => t.id))
  for (const t of tracks) {
    if (!eligibleIds.has(t.id)) noise.push(t)
  }

  const clusters = [...clusterMap.values()].sort((a, b) => b.length - a.length)
  return { clusters, noise }
}

// ── Cluster naming ────────────────────────────────────────────────────────────

export function clusterName(tracks: Track[]): string {
  // Most common genre
  const genreCounts = new Map<string, number>()
  for (const t of tracks) {
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1)
  }
  const topGenre = [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  // BPM range — use 5th and 95th percentile to exclude outliers
  const bpms = tracks.map((t) => t.bpm).filter((b): b is number => b != null).sort((a, b) => a - b)
  let bpmStr = ''
  if (bpms.length > 0) {
    const lo = bpms[Math.floor(bpms.length * 0.05)]
    const hi = bpms[Math.floor(bpms.length * 0.95)]
    bpmStr = lo === hi ? ` · ${Math.round(lo)}` : ` · ${Math.round(lo)}–${Math.round(hi)}`
  }

  return (topGenre || 'Mixed') + bpmStr
}

// ── Key-range label for display ───────────────────────────────────────────────

export function clusterKeyLabel(tracks: Track[]): string {
  const keys = tracks.map((t) => t.key).filter(Boolean) as string[]
  if (!keys.length) return ''
  const counts = new Map<string, number>()
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k)
  return top.join(' / ')
}
