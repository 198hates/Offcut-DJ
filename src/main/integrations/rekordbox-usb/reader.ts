// Reads a prepared Rekordbox USB's `PIONEER/rekordbox/export.pdb` — the
// DeviceSQL binary format CDJs use (NOT the SQLCipher desktop master.db).
//
// Parsing is done by the committed Kaitai parser generated from Deep Symmetry's
// crate-digger `rekordbox_pdb.ksy` grammar (see ./kaitai). We only walk the
// tables we need (tracks + the lookups they reference, plus the playlist tree
// and entries) and project them into plain objects.

import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import KaitaiStream from 'kaitai-struct/KaitaiStream'
// Generated UMD module — no type declarations ship with it.
import RekordboxPdb from './kaitai/RekordboxPdb.cjs'
import type { UsbTrack, UsbPlaylistNode, UsbExport } from './types'

// Kaitai PageType enum values (from the grammar).
const PT = (RekordboxPdb as { PageType: Record<string, number> }).PageType

/* eslint-disable @typescript-eslint/no-explicit-any */

function devStr(s: any): string {
  try {
    return s && s.body && typeof s.body.text === 'string' ? s.body.text : ''
  } catch {
    return ''
  }
}

/** Walk every present row of a table (following its page chain). */
function* tableRows(pdb: any, type: number): Generator<any> {
  const table = pdb.tables.find((t: any) => t.type === type)
  if (!table) return
  const lastIndex = table.lastPage.index
  let ref = table.firstPage
  let guard = 0
  while (ref && guard++ < 200000) {
    let page: any
    try {
      page = ref.body
    } catch {
      break
    }
    // A table's pages all share its type; the moment the chain crosses into a
    // page of another type we've left the table (per the grammar's own note —
    // `last_page` alone isn't a reliable terminator).
    if (page && page.type !== type) break
    if (page && page.isDataPage) {
      for (const rg of page.rowGroups) {
        for (const row of rg.rows) {
          let present = false
          try {
            present = row.present
          } catch {
            present = false
          }
          if (!present) continue
          let body: any = null
          try {
            body = row.body
          } catch {
            body = null
          }
          if (body) yield body
        }
      }
    }
    if (page && page.pageIndex === lastIndex) break
    ref = page ? page.nextPage : null
  }
}

function nameMap(pdb: any, type: number): Map<number, string> {
  const m = new Map<number, string>()
  for (const r of tableRows(pdb, type)) m.set(r.id, devStr(r.name))
  return m
}

interface RawPlaylist {
  id: number
  name: string
  isFolder: boolean
  parentId: number
  sortOrder: number
}

/** Parse an export.pdb buffer into tracks + a nested playlist tree (+ artist lookup). */
export function parseExportPdb(buf: Buffer): {
  tracks: UsbTrack[]
  playlists: UsbPlaylistNode[]
  artists: { id: number; name: string }[]
} {
  const pdb = new RekordboxPdb(new KaitaiStream(buf), null, null, false)

  const artists = nameMap(pdb, PT.ARTISTS)
  const albums = nameMap(pdb, PT.ALBUMS)
  const keys = nameMap(pdb, PT.KEYS)
  const genres = nameMap(pdb, PT.GENRES)

  const tracks: UsbTrack[] = []
  const trackById = new Map<number, UsbTrack>()
  for (const t of tableRows(pdb, PT.TRACKS)) {
    const track: UsbTrack = {
      id: t.id,
      title: devStr(t.title),
      artist: artists.get(t.artistId) || '',
      album: albums.get(t.albumId) || '',
      key: keys.get(t.keyId) || '',
      genre: genres.get(t.genreId) || '',
      bpm: t.tempo ? t.tempo / 100 : null,
      durationSeconds: t.duration || null,
      year: t.year || null,
      rating: t.rating || 0,
      filePath: devStr(t.filePath),
      analyzePath: devStr(t.analyzePath)
    }
    tracks.push(track)
    trackById.set(track.id, track)
  }

  const raw: RawPlaylist[] = []
  for (const p of tableRows(pdb, PT.PLAYLIST_TREE)) {
    raw.push({ id: p.id, name: devStr(p.name), isFolder: p.isFolder, parentId: p.parentId, sortOrder: p.sortOrder })
  }
  const entriesByPlaylist = new Map<number, { entryIndex: number; trackId: number }[]>()
  for (const e of tableRows(pdb, PT.PLAYLIST_ENTRIES)) {
    const list = entriesByPlaylist.get(e.playlistId) ?? []
    list.push({ entryIndex: e.entryIndex, trackId: e.trackId })
    entriesByPlaylist.set(e.playlistId, list)
  }

  const byParent = new Map<number, RawPlaylist[]>()
  for (const p of raw) {
    const list = byParent.get(p.parentId) ?? []
    list.push(p)
    byParent.set(p.parentId, list)
  }

  const build = (parentId: number): UsbPlaylistNode[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => {
        if (p.isFolder) {
          return { id: p.id, name: p.name, isFolder: true, children: build(p.id) }
        }
        const entries = (entriesByPlaylist.get(p.id) ?? []).sort((a, b) => a.entryIndex - b.entryIndex)
        return {
          id: p.id,
          name: p.name,
          isFolder: false,
          trackIds: entries.map((e) => e.trackId).filter((id) => trackById.has(id))
        }
      })

  const artistList = [...artists.entries()].map(([id, name]) => ({ id, name }))
  return { tracks, playlists: build(0), artists: artistList }
}

// ── USB discovery ──────────────────────────────────────────────────────────

/** Relative path of the library db within a prepared USB. */
const PDB_REL = join('PIONEER', 'rekordbox', 'export.pdb')

/** Resolve a user-provided path (volume root, rekordbox dir, or the file) to the export.pdb. */
export function resolveExportPdb(input: string): string | null {
  const candidates = [input, join(input, PDB_REL), join(input, 'rekordbox', 'export.pdb'), join(input, 'export.pdb')]
  return candidates.find((p) => { try { return statSync(p).isFile() } catch { return false } }) ?? null
}

/** Scan mounted volumes for a prepared Rekordbox USB. Returns volume roots. */
export function findRekordboxUsbs(): string[] {
  const roots: string[] = []
  // macOS / Linux removable mounts live under /Volumes (mac) — Windows uses drive letters.
  const mountDirs = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`)
    : (() => { try { return readdirSync('/Volumes').map((v) => `/Volumes/${v}`) } catch { return [] } })()
  for (const root of mountDirs) {
    if (existsSync(join(root, PDB_REL))) roots.push(root)
  }
  return roots
}

export interface UsbVolume {
  root: string
  name: string
  /** True if it already has a Rekordbox export.pdb. */
  hasRekordbox: boolean
}

/** List mounted volumes (for picking a blank stick to initialise). */
export function listUsbVolumes(): UsbVolume[] {
  const out: UsbVolume[] = []
  if (process.platform === 'win32') {
    for (const d of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${d}:\\`
      if (existsSync(root)) out.push({ root, name: `${d}:`, hasRekordbox: existsSync(join(root, PDB_REL)) })
    }
  } else {
    let vols: string[] = []
    try { vols = readdirSync('/Volumes') } catch { vols = [] }
    for (const v of vols) {
      const root = `/Volumes/${v}`
      out.push({ root, name: v, hasRekordbox: existsSync(join(root, PDB_REL)) })
    }
  }
  return out
}

/** Read a prepared USB (by volume root or direct export.pdb path) into a structured export. */
export function readRekordboxUsb(input: string): UsbExport {
  const pdbPath = resolveExportPdb(input)
  if (!pdbPath) throw new Error(`No Rekordbox export.pdb found at: ${input}`)
  const { tracks, playlists } = parseExportPdb(readFileSync(pdbPath))
  return { pdbPath, trackCount: tracks.length, tracks, playlists }
}
