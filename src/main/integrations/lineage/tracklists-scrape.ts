// Best-effort public 1001Tracklists scraper — the fallback when no partner API
// is configured. Opt-in only (settings.enableTracklistsScrape), because 1001TL's
// ToS restricts scraping and the markup can change without notice. Everything
// here returns empty on anything unexpected so discovery never breaks.
//
// Two halves, each matched to how 1001TL serves the page:
//   • Tracklist pages are SERVER-rendered → plain fetch + cheerio (fast, cheap).
//     Track rows are `div.tlpItem` → `span.trackValue` = "Artist - Title".
//     (Same selectors as the maintained elte0/1001-tracklists-api parser.)
//   • Search / listings are JS-rendered → a hidden Electron BrowserWindow loads
//     the page so its scripts run, then we scrape the live DOM for tracklist URLs.
//     A real Chromium also clears the JS challenge a bare fetch can't.

import { BrowserWindow } from 'electron'
import * as cheerio from 'cheerio'
import type { SetTrack } from './tracklists'

const BASE = 'https://www.1001tracklists.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Parse a server-rendered tracklist page into its ordered tracks. */
export async function fetchTracklistTracks(url: string): Promise<SetTrack[]> {
  let html: string
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })
    if (!res.ok) return []
    html = await res.text()
  } catch {
    return []
  }

  const $ = cheerio.load(html)
  const tracks: SetTrack[] = []
  $('div.tlpItem span.trackValue').each((_i, el) => {
    const raw = $(el).text().replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
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

/** Collect hrefs matching a path fragment from a rendered page (in-page JS). */
const COLLECT = (frag: string): string =>
  `[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>h&&h.includes(${JSON.stringify(frag)}))`

const abs = (href: string): string => (href.startsWith('http') ? href : BASE + (href.startsWith('/') ? '' : '/') + href)
const uniq = (xs: string[]): string[] => [...new Set(xs)]

/**
 * Find tracklist URLs for a seed via the JS-rendered search. Renders the search
 * page in a hidden window; collects tracklist links directly, and if the results
 * are track pages instead, opens the top track page to harvest the sets that
 * feature it. Returns up to `max` absolute tracklist URLs.
 */
export async function searchTracklistUrls(query: string, max = 8): Promise<string[]> {
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.setUserAgent(UA)

    const searchUrl = `${BASE}/search/result.php?main_search=${encodeURIComponent(query)}`
    let tl = await renderAndCollect(win, searchUrl, '/tracklist/')

    // Search surfaced track pages, not tracklists → follow the top track page,
    // whose right pane lists the tracklists that feature it.
    if (tl.length === 0) {
      const trackPages = (await collect(win, '/track/')).slice(0, 2)
      for (const tp of trackPages) {
        const more = await renderAndCollect(win, abs(tp), '/tracklist/')
        tl.push(...more)
        if (tl.length >= max) break
      }
    }

    return uniq(tl.map(abs)).slice(0, max)
  } catch {
    return []
  } finally {
    win?.destroy()
  }
}

/** Load a URL in the window, wait for the target links to render, return them. */
async function renderAndCollect(win: BrowserWindow, url: string, frag: string): Promise<string[]> {
  try {
    await withTimeout(win.loadURL(url), 15000)
  } catch {
    return []
  }
  // Results stream in via AJAX after load — poll the live DOM for up to ~8s.
  for (let waited = 0; waited < 8000; waited += 800) {
    const found = await collect(win, frag)
    if (found.length) return found
    await delay(800)
  }
  return collect(win, frag)
}

async function collect(win: BrowserWindow, frag: string): Promise<string[]> {
  try {
    const res = (await win.webContents.executeJavaScript(COLLECT(frag), true)) as string[]
    return Array.isArray(res) ? res : []
  } catch {
    return []
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}
