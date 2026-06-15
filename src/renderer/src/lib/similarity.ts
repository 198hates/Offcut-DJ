/**
 * similarity.ts — rank tracks by audio-content similarity.
 *
 * Feature vectors (see audioFeatures.ts) have dimensions on wildly different
 * scales, so we standardise each dimension across the supplied library before
 * comparing — this makes cosine meaningful and adapts to the user's collection
 * rather than relying on magic per-feature constants. Model-agnostic: works for
 * the handcrafted vector today and a learned embedding later.
 */

export interface VecItem<T> {
  item: T
  vec: number[]
}

export interface Ranked<T> {
  item: T
  score: number // 0–1, higher = more similar
}

/** Per-dimension mean/std over a set of equal-length vectors. */
function distribution(vecs: number[][]): { mean: number[]; std: number[] } {
  const d = vecs[0]?.length ?? 0
  const mean = new Array(d).fill(0)
  const std = new Array(d).fill(0)
  if (!vecs.length) return { mean, std }
  for (const v of vecs) for (let i = 0; i < d; i++) mean[i] += v[i]
  for (let i = 0; i < d; i++) mean[i] /= vecs.length
  for (const v of vecs) for (let i = 0; i < d; i++) std[i] += (v[i] - mean[i]) ** 2
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] / vecs.length) || 1
  return { mean, std }
}

function zNorm(v: number[], mean: number[], std: number[]): number[] {
  return v.map((x, i) => (x - mean[i]) / std[i])
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const den = Math.sqrt(na) * Math.sqrt(nb)
  return den ? dot / den : 0
}

/**
 * Rank `candidates` by audio similarity to `query`. The distribution used for
 * standardisation is drawn from the query + all candidates (the working library
 * subset). Returns the top `k`, most-similar first. `score` is cosine mapped to
 * 0–1.
 */
export function findSimilar<T>(query: number[], candidates: VecItem<T>[], k = 20): Ranked<T>[] {
  if (!query.length || !candidates.length) return []
  const all = [query, ...candidates.map((c) => c.vec)].filter((v) => v.length === query.length)
  const { mean, std } = distribution(all)
  const q = zNorm(query, mean, std)
  return candidates
    .filter((c) => c.vec.length === query.length)
    .map((c) => ({ item: c.item, score: (cosine(q, zNorm(c.vec, mean, std)) + 1) / 2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/**
 * A 0–1 audio-similarity between two vectors, standardised against `library`.
 * For blending into other scorers (SetBuilder suggestions, roadNotTaken). Returns
 * null when either vector is missing/mismatched so callers can fall back.
 */
export function audioSimilarity(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
  library: number[][]
): number | null {
  if (!a?.length || !b?.length || a.length !== b.length) return null
  const ref = library.filter((v) => v.length === a.length)
  const { mean, std } = distribution(ref.length ? ref : [a, b])
  return (cosine(zNorm(a, mean, std), zNorm(b, mean, std)) + 1) / 2
}
