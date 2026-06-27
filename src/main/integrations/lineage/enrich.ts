// Turn whatever the user dropped in (a Discogs release id, or artist + title
// read from existing tags) into a canonical "seed": label(s), the
// remixers/producers credited, the style tags and the year.

import type { DiscogsClient, DiscogsExtraArtist, DiscogsSearchResult } from './discogs'
import type { Credit, EnrichInput, PlayerCredit, Seed, SeedCandidate } from './types'

// Instrument roles we follow for the "shared players" route (session musicians).
const INSTRUMENT =
  /bass|drum|guitar|keys|keyboard|piano|rhodes|organ|sax|trumpet|trombone|horn|flute|percussion|synth|vibraphone|cello|violin|strings|vocals|vocal/i

function parseCredits(extraartists: DiscogsExtraArtist[] = []): {
  remixers: Credit[]
  producers: Credit[]
  players: PlayerCredit[]
} {
  const remixers: Credit[] = []
  const producers: Credit[] = []
  const players: PlayerCredit[] = []
  const seenPlayer = new Set<number>()
  for (const a of extraartists) {
    const role = (a.role || '').toLowerCase()
    if (role.includes('remix')) remixers.push({ id: a.id ?? null, name: a.name })
    else if (role.includes('produc')) producers.push({ id: a.id ?? null, name: a.name })
    else if (INSTRUMENT.test(role) && a.id && !seenPlayer.has(a.id)) {
      seenPlayer.add(a.id)
      players.push({ id: a.id, name: a.name, role: a.role })
    }
  }
  return { remixers, producers, players }
}

// Discogs search results combine the performer and title into one line
// ("Artist - Title"). Split on the first hyphen so the picker can show them
// in separate columns; fall back to the whole line as the title.
function splitArtistTitle(raw: string): { artist: string; title: string } {
  const m = raw.match(/^(.*?)\s+[-–—]\s+(.*)$/)
  if (m) return { artist: m[1].trim(), title: m[2].trim() }
  return { artist: '', title: raw.trim() }
}

function toSeedCandidate(r: DiscogsSearchResult): SeedCandidate {
  const { artist, title } = splitArtistTitle(r.title || '')
  const year = r.year != null ? Number(r.year) || null : null
  return {
    releaseId: r.id,
    artist,
    title,
    raw: r.title || '',
    year,
    label: r.label?.[0] ?? null,
    format: r.format?.join(', ') || null,
    country: r.country ?? null,
    thumb: r.thumb || r.cover_image || null
  }
}

// ── Seed-result ranking ──────────────────────────────────────────────────────
// Discogs relevance happily ranks a Various-Artists compilation or a later
// reissue above an artist's own original pressing. We re-rank its results so the
// release whose ARTIST actually matches what the user typed wins — and so a comp
// never seeds the dig unless the user literally asked for "Various".
const normName = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ') // strip Discogs "(16)" disambiguation
    .replace(/\bfeat\.?\b.*$/i, '') // strip "feat. …"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const yearOf = (r: DiscogsSearchResult): number =>
  r.year != null && Number(r.year) ? Number(r.year) : Number.POSITIVE_INFINITY

function scoreSeedResult(r: DiscogsSearchResult, typedArtist: string, typedTitle: string): number {
  const { artist, title } = splitArtistTitle(r.title || '')
  const a = normName(artist)
  const t = normName(title)
  const qa = normName(typedArtist)
  const qt = normName(typedTitle)
  let score = 0
  if (qa) {
    if (a === qa) score += 100
    else if (a && (a.includes(qa) || qa.includes(a))) score += 55
    // "Various" / VA when the user didn't ask for it ⇒ almost certainly the wrong seed.
    if (/\bvarious\b/.test(a) && !/\bvarious\b/.test(qa)) score -= 90
  }
  if (qt) {
    if (t === qt) score += 50
    else if (t && (t.includes(qt) || qt.includes(t))) score += 20
  }
  // Prefer original singles/EPs over compilations & "best of" packages.
  if (/compilation/.test((r.format || []).join(' ').toLowerCase())) score -= 25
  return score
}

// Rank by match score, then earliest year (the original pressing), then the
// order Discogs returned them.
function rankSeedResults(
  results: DiscogsSearchResult[],
  typedArtist = '',
  typedTitle = ''
): DiscogsSearchResult[] {
  return results
    .map((r, i) => ({ r, i, s: scoreSeedResult(r, typedArtist, typedTitle) }))
    .sort((x, y) => y.s - x.s || yearOf(x.r) - yearOf(y.r) || x.i - y.i)
    .map((x) => x.r)
}

// Run the same exact→fuzzy search the picker uses, returning ranked matches.
// Exact artist/track first; if that's empty, retry as one free-text query so a
// typo or odd punctuation doesn't dead-end the dig.
async function searchReleaseResults(
  discogs: DiscogsClient,
  artist?: string,
  title?: string
): Promise<DiscogsSearchResult[]> {
  const exact = await discogs.searchRelease({ artist, track: title })
  if (exact.results?.length) return exact.results
  const q = [artist, title].filter(Boolean).join(' ').trim()
  if (!q) return []
  const fuzzy = await discogs.searchRelease({ q })
  return fuzzy.results ?? []
}

/** Top Discogs matches for a typed artist/title — drives the seed picker. */
export async function searchSeeds(
  discogs: DiscogsClient,
  input: { artist?: string; title?: string }
): Promise<SeedCandidate[]> {
  const results = await searchReleaseResults(discogs, input.artist, input.title)
  return rankSeedResults(results, input.artist, input.title).map(toSeedCandidate)
}

// input: { discogsReleaseId } OR { artist, title }
export async function enrich(discogs: DiscogsClient, input: EnrichInput): Promise<Seed | null> {
  let releaseId = input.discogsReleaseId

  // No release id? Search by artist + title (exact, then fuzzy) and take the best hit.
  if (!releaseId) {
    const results = await searchReleaseResults(discogs, input.artist, input.title)
    if (!results.length) {
      // No Discogs match (newer / underground / mistagged release). Don't dead-end
      // the dig — return a minimal seed from the artist/title so the keyless sonic
      // routes (Deezer related-artists especially) can still build a graph. The
      // Discogs-fed routes (credits / labels / comps) simply stay empty.
      const artist = (input.artist || '').trim()
      const title = (input.title || '').trim()
      if (!artist && !title) return null
      return {
        releaseId: null,
        artist,
        artists: [],
        title,
        year: null,
        labels: [],
        styles: [],
        genres: [],
        remixers: [],
        producers: [],
        players: []
      }
    }
    // Smart auto-pick: the best artist/title match, not Discogs' raw top hit.
    releaseId = rankSeedResults(results, input.artist, input.title)[0].id
  }

  const r = await discogs.getRelease(releaseId)

  // A remixer is often credited only on one track, so gather track-level
  // credits as well as release-level ones.
  const trackExtra = (r.tracklist || []).flatMap((t) => t.extraartists || [])
  const { remixers, producers, players } = parseCredits([...(r.extraartists || []), ...trackExtra])

  return {
    releaseId,
    artist: (r.artists || []).map((a) => a.name).join(', '),
    artists: (r.artists || []).map((a) => ({ id: a.id ?? null, name: a.name })),
    title: input.title || r.title,
    year: r.year || null,
    labels: (r.labels || []).map((l) => ({ id: l.id ?? null, name: l.name })),
    styles: r.styles || [],
    genres: r.genres || [],
    remixers,
    producers,
    players
  }
}
