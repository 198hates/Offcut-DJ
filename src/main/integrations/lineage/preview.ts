// Finds a 30-second preview for a track from open, no-key catalogues.
// Order: Deezer search (strict then loose) → iTunes Search API → an ISRC-exact
// Deezer lookup via MusicBrainz (keyless). External "open in" links are always
// returned as a fallback — some underground / Bandcamp-only releases won't be
// in any catalogue, so the UI must handle the null-preview case gracefully.

import { RateLimiter } from './rate-limiter'
import { deezerByIsrc } from './identity'
import { looksLikeMatch } from './match'
import type { Identity } from './identity'
import type { LibraryTrackRef, PreviewLinks, PreviewResult } from './types'

const itunesLimiter = new RateLimiter(3500) // iTunes Search API: ~20/min

interface DeezerSearchItem {
  id?: number
  preview?: string
  link?: string
  title?: string
  bpm?: number
  artist?: { name?: string }
  album?: { cover_medium?: string; cover_big?: string }
}

// Deezer's /track/{id} carries a `bpm` (0 when unknown) the search result omits.
async function deezerBpm(id?: number): Promise<number | null> {
  if (!id) return null
  try {
    const res = await fetch(`https://api.deezer.com/track/${id}`)
    if (!res.ok) return null
    const t = (await res.json()) as { bpm?: number }
    return t.bpm && t.bpm > 0 ? Math.round(t.bpm) : null
  } catch {
    return null
  }
}

async function deezerSearch(q: string): Promise<DeezerSearchItem[]> {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`)
    if (!res.ok) return []
    const { data = [] } = (await res.json()) as { data?: DeezerSearchItem[] }
    return data
  } catch {
    return []
  }
}

async function deezerResult(hit: DeezerSearchItem): Promise<Partial<PreviewResult>> {
  // Prefer the bpm on the search hit; otherwise fetch the track detail for it.
  const bpm = hit.bpm && hit.bpm > 0 ? Math.round(hit.bpm) : await deezerBpm(hit.id)
  return {
    source: 'deezer',
    previewUrl: hit.preview,
    externalUrl: hit.link,
    artworkUrl: hit.album?.cover_big || hit.album?.cover_medium || null,
    bpm
  }
}

async function fromDeezer({ artist, title }: LibraryTrackRef): Promise<Partial<PreviewResult> | null> {
  const match = (data: DeezerSearchItem[]): DeezerSearchItem | undefined =>
    data.find((d) => d.preview && looksLikeMatch({ artist, title }, d.artist?.name, d.title))

  // Strict field query first; many underground / mistagged releases miss it, so
  // fall back to a plain free-text query before giving up.
  const strict = match(await deezerSearch(`artist:"${artist}" track:"${title}"`))
  const hit = strict || match(await deezerSearch(`${artist} ${title}`))
  return hit?.preview ? deezerResult(hit) : null
}

// Last resort: resolve the recording's ISRC via MusicBrainz (keyless), then ask
// Deezer for that exact ISRC. Catches tracks whose fuzzy search misses but that
// genuinely exist in the catalogue. Costs ~2 MusicBrainz calls, so only run it
// once the catalogue searches have failed.
async function fromIsrc(
  { artist, title }: LibraryTrackRef,
  identity: Identity
): Promise<Partial<PreviewResult> | null> {
  try {
    const mbid = await identity.recordingByArtistTitle({ artist, title })
    if (!mbid) return null
    const isrcs = await identity.isrcsForRecording(mbid)
    for (const isrc of isrcs) {
      const t = await deezerByIsrc(isrc)
      if (t?.preview) {
        return { source: 'deezer', previewUrl: t.preview, externalUrl: t.link, bpm: null }
      }
    }
  } catch {
    /* best-effort */
  }
  return null
}

interface ItunesItem {
  previewUrl?: string
  trackViewUrl?: string
  artistName?: string
  trackName?: string
  artworkUrl100?: string
}

async function fromItunes({ artist, title }: LibraryTrackRef): Promise<Partial<PreviewResult> | null> {
  const term = encodeURIComponent(`${artist} ${title}`)
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5`
  const res = await itunesLimiter.schedule(() => fetch(url))
  if (!res.ok) return null
  const { results = [] } = (await res.json()) as { results?: ItunesItem[] }
  const hit = results.find(
    (r) => r.previewUrl && looksLikeMatch({ artist, title }, r.artistName, r.trackName)
  )
  if (!hit || !hit.previewUrl) return null
  // NOTE: iTunes terms require a store link/badge shown next to the player
  // when you use a preview — surface storeUrl in the UI.
  return {
    source: 'itunes',
    previewUrl: hit.previewUrl,
    externalUrl: hit.trackViewUrl,
    storeUrl: hit.trackViewUrl,
    // Upscale the 100px thumbnail Apple returns to a crisper cover.
    artworkUrl: hit.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '300x300') : null
  }
}

function externalLinks({ artist, title }: LibraryTrackRef): PreviewLinks {
  const q = encodeURIComponent(`${artist} ${title}`)
  return {
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    soundcloud: `https://soundcloud.com/search?q=${q}`,
    bandcamp: `https://bandcamp.com/search?q=${q}`
  }
}

// track: { artist, title }  ->  PreviewResult
// Fetch this at play time (Deezer preview URLs expire after a few hours).
// `identity` (optional) enables the keyless ISRC-exact fallback.
export async function preview(
  { artist, title }: LibraryTrackRef,
  identity?: Identity
): Promise<PreviewResult> {
  const found =
    (await fromDeezer({ artist, title })) ||
    (await fromItunes({ artist, title })) ||
    (identity ? await fromIsrc({ artist, title }, identity) : null)
  return {
    source: null,
    previewUrl: null,
    ...(found || {}),
    links: externalLinks({ artist, title }) // always present, for the miss case
  }
}
