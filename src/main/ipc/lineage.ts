// Lineage IPC — library expansion / crate-digging.
// Maps the engine's flat API onto ipcMain.handle channels. The engine is built
// lazily from current settings and rebuilt when the Discogs token changes.
// Errors thrown inside a handler surface as a rejected promise at the renderer's
// await, so the UI can show the message.

import { ipcMain, dialog, app } from 'electron'
import { join } from 'path'
import { getLibraryDb } from '../library/db'
import { loadSettings } from '../settings'
import { createLineageEngine } from '../integrations/lineage'
import type { LineageEngine } from '../integrations/lineage'
import type {
  LineageExportFind,
  LineageExportOptions,
  LineageExportResult,
  DiscoverOptions,
  EnrichInput,
  LibraryTrackRef,
  Seed
} from '../../shared/types'

// Descriptive UA — Discogs & MusicBrainz reject blank User-Agents.
const USER_AGENT = 'Offcut/1.0 +https://betweenthebridges.co.uk'

let _engine: LineageEngine | null = null
let _builtWithKey: string | undefined

/** Pull {artist, title} from the host library to seed dedup. */
function getLibraryTracks(): LibraryTrackRef[] {
  try {
    const db = getLibraryDb()
    return db.prepare('SELECT artist, title FROM tracks').all() as LibraryTrackRef[]
  } catch {
    return []
  }
}

/** Build (or reuse) the engine for the current settings. */
function getEngine(): LineageEngine {
  const settings = loadSettings()
  const token = settings.discogsToken?.trim() || undefined
  const acoustidKey = settings.acoustidKey?.trim() || undefined
  const lastfmKey = settings.lastfmKey?.trim() || undefined
  const tracklistsApiKey = settings.tracklistsApiKey?.trim() || undefined
  const tracklistsApiBase = settings.tracklistsApiBase?.trim() || undefined
  const enableTracklistsScrape = !!settings.enableTracklistsScrape

  // Rebuild whenever any engine-affecting key changes.
  const key = JSON.stringify([
    token,
    acoustidKey,
    lastfmKey,
    tracklistsApiKey,
    tracklistsApiBase,
    enableTracklistsScrape
  ])
  if (_engine && _builtWithKey === key) return _engine

  // Settings changed: release the previous engine's SQLite handle before
  // replacing it (rebuilds used to leak one handle per settings change).
  _engine?.close()

  _engine = createLineageEngine({
    discogsToken: token,
    acoustidKey,
    lastfmKey,
    tracklistsApiKey,
    tracklistsApiBase,
    enableTracklistsScrape,
    userAgent: USER_AGENT,
    dbPath: join(app.getPath('userData'), 'lineage.db'),
    getLibraryTracks
  })
  _builtWithKey = key
  _engine.loadLibrary(getLibraryTracks()) // seed dedup
  return _engine
}

export function registerLineageHandlers(): void {
  // Cheap status check — does NOT build the engine.
  ipcMain.handle('lineage:status', () => {
    const s = loadSettings()
    return {
      hasToken: !!s.discogsToken?.trim(),
      hasLastfm: !!s.lastfmKey?.trim(),
      // Live via the partner API, or the opt-in public scrape.
      hasTracklists:
        !!(s.tracklistsApiKey?.trim() && s.tracklistsApiBase?.trim()) || !!s.enableTracklistsScrape
    }
  })

  // Enrichment + discovery
  ipcMain.handle('lineage:enrich', (_e, input: EnrichInput) => getEngine().enrich(input))
  ipcMain.handle('lineage:searchSeeds', (_e, input: { artist?: string; title?: string }) =>
    getEngine().searchSeeds(input)
  )
  ipcMain.handle('lineage:discover', (e, seed: Seed, opts?: DiscoverOptions) =>
    getEngine().discover(seed, opts, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('lineage:progress', p)
    })
  )

  // Identity backbone (fpcalc / AcoustID / MusicBrainz)
  ipcMain.handle('lineage:identify', (_e, input: { filePath?: string; artist?: string; title?: string }) =>
    getEngine().identify(input)
  )

  // Preview / playback
  ipcMain.handle('lineage:preview', (_e, track: LibraryTrackRef) => getEngine().preview(track))
  ipcMain.handle('lineage:bandcampPreview', (_e, track: LibraryTrackRef) =>
    getEngine().bandcampPreview(track)
  )
  ipcMain.handle('lineage:bandcampEmbed', (_e, url: string) => getEngine().bandcampEmbed(url))

  // Review workflow
  ipcMain.handle('lineage:listNew', () => getEngine().listNew())
  ipcMain.handle('lineage:listSaved', () => getEngine().listSaved())
  ipcMain.handle('lineage:save', (_e, key: string) => getEngine().save(key))
  ipcMain.handle('lineage:dismiss', (_e, key: string) => getEngine().dismiss(key))

  // Dedup-source loaders + refresh
  ipcMain.handle('lineage:loadRekordbox', (_e, xmlPath: string) => getEngine().loadRekordbox(xmlPath))
  ipcMain.handle('lineage:loadSerato', (_e, cratePath: string) => getEngine().loadSerato(cratePath))
  ipcMain.handle('lineage:reloadLibrary', () => {
    getEngine().loadLibrary(getLibraryTracks())
    return true
  })

  // Export saved finds to an importable Rekordbox XML playlist.
  ipcMain.handle(
    'lineage:exportCrate',
    async (_e, opts: LineageExportOptions = {}): Promise<LineageExportResult> => {
      const engine = getEngine()
      const name = opts.name || 'Lineage'
      const finds: LineageExportFind[] =
        opts.finds && opts.finds.length
          ? opts.finds
          : engine.listSaved().map((c) => ({ artist: c.artist, title: c.title }))
      if (!finds.length) return { saved: false, error: 'No saved finds to export' }

      let outPath = opts.outPath
      if (!outPath) {
        const res = await dialog.showSaveDialog({
          title: 'Export crate as Rekordbox XML',
          defaultPath: `${name.replace(/[^\w\- ]+/g, '').trim() || 'Lineage'}.xml`,
          filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }]
        })
        if (res.canceled || !res.filePath) return { saved: false, cancelled: true }
        outPath = res.filePath
      }

      engine.exportCrate(finds, name, outPath)
      return { saved: true, path: outPath, count: finds.length }
    }
  )
}
