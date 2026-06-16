// Shared fuzzy match between a wanted track (artist + title) and a catalogue
// hit (Deezer / iTunes / MusicBrainz). Used by both the preview resolver and
// the identity verifier so "is this the right track?" is decided one way.
//
// The old check compared only the FIRST word of artist and title, so
// "David DeMarco — Silhouettes" passed for "David Bowie — Rebel Rebel" (shared
// first artist word) whenever the title's first word happened to coincide.
// This version requires most of the significant words on BOTH sides to line up.

export function normName(s = ''): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // drop "(Original Mix)", "[LABEL001]"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Significant tokens — single characters are dropped as noise. */
export function tokenize(s = ''): string[] {
  return normName(s)
    .split(' ')
    .filter((t) => t.length >= 2)
}

/** True when a wanted token is present in the candidate tokens. */
function tokenHit(want: string, got: string[]): boolean {
  return got.some(
    (g) => g === want || (want.length >= 4 && (g.startsWith(want) || want.startsWith(g)))
  )
}

/**
 * Fraction of `want` tokens present in `got` (0–1). 1 when nothing to match
 * (so a missing field never blocks a match on the other field).
 */
export function coverage(want: string[], got: string[]): number {
  if (want.length === 0) return 1
  const hits = want.filter((w) => tokenHit(w, got))
  return hits.length / want.length
}

export const ARTIST_MIN_COVERAGE = 0.6
export const TITLE_MIN_COVERAGE = 0.7

/**
 * Sanity check that a catalogue hit is really the track we asked for, so we
 * never preview (or identify against) the wrong "Silhouettes". Requires the
 * bulk of the wanted artist AND title words to appear in the candidate.
 */
export function looksLikeMatch(
  want: { artist?: string; title?: string },
  gotArtist = '',
  gotTitle = ''
): boolean {
  const artistOk = coverage(tokenize(want.artist), tokenize(gotArtist)) >= ARTIST_MIN_COVERAGE
  const titleOk = coverage(tokenize(want.title), tokenize(gotTitle)) >= TITLE_MIN_COVERAGE
  return artistOk && titleOk
}
