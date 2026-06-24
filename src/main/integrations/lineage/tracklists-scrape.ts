// Best-effort public 1001Tracklists scraper — the fallback when no partner API
// is configured. Opt-in only (settings.enableTracklistsScrape): 1001TL's ToS
// restricts scraping and the markup can change. Everything returns empty on
// anything unexpected so discovery never breaks.
//
// Co-play chain (proven against the live site), each step matched to how 1001TL
// serves that page:
//   1. Find the track's page — POST /search/result.php (search_selection=2 =
//      Tracks). Server-rendered → plain fetch + cheerio.
//   2. The track page lists the sets that feature it, but that list is
//      JS-rendered, so a hidden Electron BrowserWindow runs the page's scripts
//      and we scrape the live `/tracklist/…` links from it.
//   3. Each set page's tracks are server-rendered → fetch + cheerio of
//      `div.tlpItem span.trackValue` ("Artist - Title"; same selectors as the
//      maintained elte0/1001-tracklists-api parser).
// Sets reached via step 2 contain the seed by construction, so tallyCoPlay's
// ranking is pure co-play with no name-match noise.

import { BrowserWindow } from 'electron'
import * as cheerio from 'cheerio'
import type { SetTrack } from './tracklists'

const BASE = 'https://www.1001tracklists.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
}
const abs = (href: string): string =>
  href.startsWith('http') ? href : BASE + (href.startsWith('/') ? '' : '/') + href
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isTracklistHref = (h: string): boolean => /\/tracklist\/[a-z0-9]+\//i.test(h)

/** Step 1 — resolve the seed's 1001TL track page via the POST "Tracks" search. */
export async function findTrackPage(query: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/search/result.php`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/` },
      body: new URLSearchParams({ main_search: query, search_selection: '2' }).toString()
    })
    if (!res.ok) return null
    const $ = cheerio.load(await res.text())
    let found: string | null = null
    $('a[href*="/track/"]').each((_i, el) => {
      const href = $(el).attr('href')
      if (!found && href && /\/track\/[a-z0-9]+\//i.test(href)) found = abs(href.split('#')[0])
    })
    return found
  } catch {
    return null
  }
}

/** Step 2 — render the track page and scrape the sets that feature it. */
export async function trackSetUrls(trackUrl: string, max = 10): Promise<string[]> {
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.setUserAgent(UA)
    await withTimeout(win.loadURL(trackUrl), 15000)

    let hrefs: string[] = []
    for (let i = 0; i < 8; i++) {
      hrefs = await collectTracklistHrefs(win)
      if (hrefs.length) break
      await delay(700)
    }
    const urls = new Set<string>()
    for (const h of hrefs) if (isTracklistHref(h)) urls.add(abs(h.split('#')[0]))
    return [...urls].slice(0, max)
  } catch {
    return []
  } finally {
    win?.destroy()
  }
}

async function collectTracklistHrefs(win: BrowserWindow): Promise<string[]> {
  try {
    const r = (await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('a[href*="/tracklist/"]')].map(a=>a.getAttribute('href')).filter(Boolean)`,
      true
    )) as string[]
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}

/** Step 3 — parse a server-rendered set page into its ordered tracks. */
export async function fetchTracklistTracks(url: string): Promise<SetTrack[]> {
  let html: string
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return []
    html = await res.text()
  } catch {
    return []
  }

  const $ = cheerio.load(html)
  const tracks: SetTrack[] = []
  $('div.tlpItem span.trackValue').each((_i, el) => {
    const raw = $(el).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
    const sep = raw.indexOf(' - ')
    if (sep === -1) return
    const artist = raw.slice(0, sep).trim()
    const title = raw.slice(sep + 3).trim()
    if (!artist || !title) return
    if (/^id$/i.test(artist) && /^id$/i.test(title)) return // unidentified "ID - ID"
    tracks.push({ artist, title })
  })
  return tracks
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}
