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
  return results.map(toSeedCandidate)
}

// input: { discogsReleaseId } OR { artist, title }
export async function enrich(discogs: DiscogsClient, input: EnrichInput): Promise<Seed | null> {
  let releaseId = input.discogsReleaseId

  // No release id? Search by artist + title (exact, then fuzzy) and take the best hit.
  if (!releaseId) {
    const results = await searchReleaseResults(discogs, input.artist, input.title)
    if (!results.length) return null
    releaseId = results[0].id
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
