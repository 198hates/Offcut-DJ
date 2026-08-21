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

/**
 * Audio-content match for DUPLICATE detection, which is a different question to
 * "sounds like this" and needs a different comparison.
 *
 * The feature vector starts with the 13 MFCC means, and MFCC coefficient 0 is
 * the log of total frame energy — loudness. Scaling a signal by g adds a
 * constant to every log-mel band, and the DCT funnels that constant almost
 * entirely into c0, so c0 moves with gain while c1..c12 barely shift. It is also
 * by far the largest-magnitude dimension in the vector (measured at ~32% of the
 * squared norm on synthetic audio, c0 swinging 42.0 → -68.6 across a 12 dB
 * drop), which means a raw cosine over all 43 dims is mostly a comparison of
 * loudness.
 *
 * Measured on a bench of 10 synthetic tracks, each with a dithered copy and
 * copies at -1/-3/-6/-12 dB (150 true-duplicate pairs, 1620 different-track
 * pairs):
 *
 *   raw cosine, all 43 dims   true dupes down to -0.210, different tracks up to
 *                             0.9998 — the two ranges overlap completely, so no
 *                             threshold separates them. A 1 dB level difference
 *                             between two copies of one track was enough to miss
 *                             it at 0.995.
 *   raw cosine, c0 dropped    true dupes >= 0.999999, different tracks <= 0.9862.
 *   z-normalised, c0 dropped  marginally wider (>= 0.999997 vs <= 0.9816) but
 *                             the score then depends on library composition, so
 *                             a fixed threshold stops meaning the same thing
 *                             from one collection to the next.
 *   z-normalised, all dims    still overlaps — standardising does not rescue c0,
 *                             it just gives loudness an equal vote.
 *
 * Hence: drop c0, keep the raw cosine, keep the threshold. Every other dimension
 * is already gain-invariant by construction (c1..c12 and the MFCC standard
 * deviations are unaffected by a constant offset; chroma is normalised to sum 1;
 * the spectral descriptors are ratios or divided by Nyquist), so the result is a
 * timbre-and-harmony match that survives re-encoding, re-tagging, ReplayGain and
 * a differently-mastered rip.
 *
 * Note this is the opposite trade-off to findSimilar above: there, loudness and
 * library-relative standardisation are wanted, because the question is which
 * tracks sit near each other in a collection. Here anything that moves with a
 * gain change is noise.
 */
export const DUPLICATE_MATCH_THRESHOLD = 0.995

/** Index of the MFCC-0 (loudness) dimension excluded from duplicate matching. */
const LOUDNESS_DIM = 0

/**
 * Cosine similarity for duplicate detection: raw, but blind to loudness. 1.0
 * means the same audio. Returns 0 for missing or mismatched vectors so callers
 * can compare against the threshold without a null check.
 */
export function duplicateMatch(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    if (i === LOUDNESS_DIM) continue
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const den = Math.sqrt(na) * Math.sqrt(nb)
  return den ? dot / den : 0
}
