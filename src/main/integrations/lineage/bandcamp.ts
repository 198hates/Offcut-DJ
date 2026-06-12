// Bandcamp has no public catalogue API, but two things work without any
// credentials: the official embedded player (real in-app playback, often the
// full track) and the identity metadata on a release page. The only soft spot
// is *finding* a track's page — there's no sanctioned search — so we best-effort
// scrape the public search page and keep manual paste of a URL as the reliable
// fallback. The playback path itself (embedFor) is fully above-board.

import { RateLimiter } from './rate-limiter'
import type { BandcampEmbed, LibraryTrackRef } from './types'

const limiter = new RateLimiter(1500) // be gentle with public pages
const UA = 'Mozilla/5.0 (offcut)'

// Every album/track page carries <meta name="bc-page-properties"> with
// item_type ('a' = album, 't' = track) and item_id — the cleanest identity hook.
async function pageProperties(url: string): Promise<{ itemType: string; itemId: string } | null> {
  const res = await limiter.schedule(() => fetch(url, { headers: { 'User-Agent': UA } }))
  if (!res.ok) return null
  const html = await res.text()
  const m = html.match(/name="bc-page-properties"\s+content="([^"]+)"/)
  if (!m) return null
  const props = JSON.parse(m[1].replace(/&quot;/g, '"')) as { item_type: string; item_id: string }
  return { itemType: props.item_type, itemId: props.item_id }
}

// The official embedded-player iframe src for an album/track id.
function embedSrc(itemType: string, itemId: string): string {
  const kind = itemType === 't' ? 'track' : 'album'
  return (
    `https://bandcamp.com/EmbeddedPlayer/${kind}=${itemId}/size=large/` +
    `bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/`
  )
}

// Given a known Bandcamp release URL, return what the renderer needs to drop in
// the sanctioned player. Fully above-board.
export async function embedFor(bandcampUrl: string): Promise<BandcampEmbed | null> {
  const props = await pageProperties(bandcampUrl)
  if (!props) return null
  return {
    url: bandcampUrl,
    embedSrc: embedSrc(props.itemType, props.itemId),
    itemType: props.itemType,
    itemId: props.itemId
  }
}

// Best-effort: find a track's Bandcamp page from the public search results.
// Unofficial and liable to break if Bandcamp change their markup — for anything
// reliable, prefer letting the user paste/click a URL into embedFor().
export async function findOnBandcamp({ artist, title }: LibraryTrackRef): Promise<string | null> {
  const q = encodeURIComponent(`${artist} ${title}`)
  const res = await limiter.schedule(() =>
    fetch(`https://bandcamp.com/search?q=${q}&item_type=t`, { headers: { 'User-Agent': UA } })
  )
  if (!res.ok) return null
  const html = await res.text()
  const m = html.match(/https?:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:track|album)\/[a-z0-9-]+/i)
  return m ? m[0] : null
}

// Convenience: search + embed in one call. Null if nothing matched.
export async function previewBandcamp({ artist, title }: LibraryTrackRef): Promise<BandcampEmbed | null> {
  const url = await findOnBandcamp({ artist, title })
  return url ? embedFor(url) : null
}
