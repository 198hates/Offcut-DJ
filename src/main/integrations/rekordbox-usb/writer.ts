// Append a playlist to a prepared USB's export.pdb (DeviceSQL) — M1.
//
// Strategy: APPEND-ONLY. New pages are added at the end of the file for the new
// playlist (one playlist_tree row + playlist_entries rows). Only header pointers
// of existing pages are patched (next_page / table last_page / next_unused_page);
// existing page heaps are never rewritten, so existing data can't be corrupted.
//
// Validated by round-trip: the M0 reader parses the result back with the new
// playlist + entries intact. NOTE: this updates export.pdb only — not the
// encrypted exportLibrary.db (CDJ-3000's preferred index) — so confirm on real
// hardware before relying on it for a set.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { resolveExportPdb, parseExportPdb } from './reader'
import { buildDatAnlz, beatsFromMarkers, beatsFromBpm, type AnlzBeat } from './anlz'
import type { UsbPlaylistNode, UsbTrack } from './types'
import type { BeatgridMarker } from '../../../shared/types'
// Generated Kaitai parser — used here only for its PageType enum.
import RekordboxPdb from './kaitai/RekordboxPdb.cjs'

const PT = (RekordboxPdb as { PageType: Record<string, number> }).PageType

const PAGE = 4096
const HEADER = 0x28
const GROUP_STRIDE = 0x24
const ENTRY_SIZE = 12
const MAX_ENTRIES_PER_PAGE = 256

// ── DeviceSQL string: short-ascii (header 2*len+3) / long-ascii / long-utf16le ──
function deviceSqlString(s: string): Buffer {
  s = s || ''
  const isAscii = /^[\x00-\x7F]*$/.test(s)
  if (isAscii && s.length <= 126) {
    return Buffer.concat([Buffer.from([s.length * 2 + 3]), Buffer.from(s, 'ascii')])
  }
  const body = Buffer.from(s, isAscii ? 'ascii' : 'utf16le')
  const head = Buffer.alloc(4)
  head.writeUInt8(isAscii ? 0x40 : 0x90, 0)
  head.writeUInt16LE(body.length + 4, 1)
  head.writeUInt8(0, 3)
  return Buffer.concat([head, body])
}

function playlistTreeRow(o: { parentId: number; sortOrder: number; id: number; isFolder: boolean; name: string }): Buffer {
  const head = Buffer.alloc(20)
  head.writeUInt32LE(o.parentId >>> 0, 0)
  head.writeUInt32LE(0, 4)
  head.writeUInt32LE(o.sortOrder >>> 0, 8)
  head.writeUInt32LE(o.id >>> 0, 12)
  head.writeUInt32LE(o.isFolder ? 1 : 0, 16)
  return Buffer.concat([head, deviceSqlString(o.name)])
}

function playlistEntryRow(o: { entryIndex: number; trackId: number; playlistId: number }): Buffer {
  const b = Buffer.alloc(ENTRY_SIZE)
  b.writeUInt32LE(o.entryIndex >>> 0, 0)
  b.writeUInt32LE(o.trackId >>> 0, 4)
  b.writeUInt32LE(o.playlistId >>> 0, 8)
  return b
}

function buildPage(o: { pageIndex: number; type: number; nextPage: number; rows: Buffer[] }): Buffer {
  const page = Buffer.alloc(PAGE)
  page.writeUInt32LE(0, 0)
  page.writeUInt32LE(o.pageIndex >>> 0, 4)
  page.writeUInt32LE(o.type >>> 0, 8)
  page.writeUInt32LE(o.nextPage >>> 0, 12)
  page.writeUInt32LE(0, 16)
  page.writeUInt32LE(0, 20)

  const n = o.rows.length
  const packed = (n & 0x1fff) | ((n & 0x7ff) << 13)
  page.writeUIntLE(packed >>> 0, 24, 3)
  page.writeUInt8(0x24, 27) // data page

  const offsets: number[] = []
  let heap = 0
  for (const r of o.rows) {
    offsets.push(heap)
    r.copy(page, HEADER + heap)
    heap += r.length
  }

  const numGroups = Math.max(1, Math.ceil(n / 16))
  for (let g = 0; g < numGroups; g++) {
    const base = PAGE - g * GROUP_STRIDE
    let present = 0
    for (let r = 0; r < 16; r++) if (g * 16 + r < n) present |= 1 << r
    page.writeUInt16LE(present, base - 4)
    for (let r = 0; r < 16; r++) {
      const gi = g * 16 + r
      page.writeUInt16LE(gi < n ? offsets[gi] & 0xffff : 0, base - 6 - 2 * r)
    }
  }
  const capacity = PAGE - HEADER - numGroups * GROUP_STRIDE
  page.writeUInt16LE(Math.max(0, capacity - heap) & 0xffff, 28)
  page.writeUInt16LE(heap & 0xffff, 30)
  return page
}

const TABLES_OFFSET = 28
const TABLE_SIZE = 16
function findTable(buf: Buffer, numTables: number, type: number): number {
  for (let i = 0; i < numTables; i++) {
    const off = TABLES_OFFSET + i * TABLE_SIZE
    if (buf.readUInt32LE(off) === type) return off
  }
  return -1
}
const tableLastPage = (buf: Buffer, off: number): number => buf.readUInt32LE(off + 12)
const setTableLastPage = (buf: Buffer, off: number, v: number): void => { buf.writeUInt32LE(v >>> 0, off + 12) }
const setPageNext = (buf: Buffer, pageIndex: number, v: number): void => { buf.writeUInt32LE(v >>> 0, pageIndex * PAGE + 12) }

export interface AddPlaylistOptions {
  name: string
  /** Existing USB track IDs, in playlist order. */
  trackIds: number[]
  newPlaylistId: number
  sortOrder: number
}

/** Append a playlist to an export.pdb buffer. Returns a NEW buffer; input is not mutated. */
export function addPlaylistToExportPdb(input: Buffer, opts: AddPlaylistOptions): Buffer {
  const buf = Buffer.from(input)
  const lenPage = buf.readUInt32LE(4)
  if (lenPage !== PAGE) throw new Error(`unexpected page size ${lenPage}`)
  const numTables = buf.readUInt32LE(8)

  const treeOff = findTable(buf, numTables, PT.PLAYLIST_TREE)
  const entOff = findTable(buf, numTables, PT.PLAYLIST_ENTRIES)
  if (treeOff < 0 || entOff < 0) throw new Error('playlist tables not found in export.pdb')

  let nextIndex = buf.length / PAGE
  const newPages: { index: number; type: number; rows: Buffer[] }[] = []

  const entriesLast = tableLastPage(buf, entOff)
  const entryPageIndices: number[] = []
  for (let i = 0; i < opts.trackIds.length; i += MAX_ENTRIES_PER_PAGE) {
    const chunk = opts.trackIds.slice(i, i + MAX_ENTRIES_PER_PAGE)
    const idx = nextIndex++
    entryPageIndices.push(idx)
    newPages.push({
      index: idx,
      type: PT.PLAYLIST_ENTRIES,
      rows: chunk.map((tid, j) => playlistEntryRow({ entryIndex: i + j + 1, trackId: tid, playlistId: opts.newPlaylistId }))
    })
  }

  const treeLast = tableLastPage(buf, treeOff)
  const treeIdx = nextIndex++
  newPages.push({
    index: treeIdx,
    type: PT.PLAYLIST_TREE,
    rows: [playlistTreeRow({ parentId: 0, sortOrder: opts.sortOrder, id: opts.newPlaylistId, isFolder: false, name: opts.name })]
  })

  const out = Buffer.concat([buf, Buffer.alloc(newPages.length * PAGE)])
  for (const p of newPages) buildPage({ pageIndex: p.index, type: p.type, nextPage: 0xffffffff, rows: p.rows }).copy(out, p.index * PAGE)

  if (entryPageIndices.length) {
    setPageNext(out, entriesLast, entryPageIndices[0])
    for (let i = 0; i < entryPageIndices.length - 1; i++) setPageNext(out, entryPageIndices[i], entryPageIndices[i + 1])
    setTableLastPage(out, entOff, entryPageIndices[entryPageIndices.length - 1])
  }
  setPageNext(out, treeLast, treeIdx)
  setTableLastPage(out, treeOff, treeIdx)
  out.writeUInt32LE(out.length / PAGE, 12) // next_unused_page

  return out
}

/** Append entries to an EXISTING playlist (incremental sync). Returns a new buffer. */
export function addEntriesToExportPdb(
  input: Buffer,
  playlistId: number,
  trackIds: number[],
  startIndex: number
): Buffer {
  if (!trackIds.length) return input
  const buf = Buffer.from(input)
  const numTables = buf.readUInt32LE(8)
  const entOff = findTable(buf, numTables, PT.PLAYLIST_ENTRIES)
  if (entOff < 0) throw new Error('playlist_entries table not found')

  let nextIndex = buf.length / PAGE
  const pageIndices: number[] = []
  const pages: Buffer[] = []
  for (let i = 0; i < trackIds.length; i += MAX_ENTRIES_PER_PAGE) {
    const chunk = trackIds.slice(i, i + MAX_ENTRIES_PER_PAGE)
    const idx = nextIndex++
    pageIndices.push(idx)
    pages.push(
      buildPage({
        pageIndex: idx,
        type: PT.PLAYLIST_ENTRIES,
        nextPage: 0xffffffff,
        rows: chunk.map((tid, j) =>
          playlistEntryRow({ entryIndex: startIndex + i + j + 1, trackId: tid, playlistId })
        )
      })
    )
  }
  const out = Buffer.concat([buf, ...pages])
  const oldLast = tableLastPage(out, entOff)
  setPageNext(out, oldLast, pageIndices[0])
  for (let i = 0; i < pageIndices.length - 1; i++) setPageNext(out, pageIndices[i], pageIndices[i + 1])
  setTableLastPage(out, entOff, pageIndices[pageIndices.length - 1])
  out.writeUInt32LE(out.length / PAGE, 12)
  return out
}

// ── New track insertion (M2a) ────────────────────────────────────────────────

export interface NewTrackFields {
  id: number
  title: string
  /** Device-relative audio path, e.g. /Contents/Offcut/x.mp3 */
  filePath: string
  filename: string
  /** Device-relative ANLZ path, e.g. /PIONEER/USBANLZ/OFCT/00000F43/ANLZ0000.DAT */
  analyzePath: string
  bpm: number
  durationSec: number
  bitrate?: number
  fileSize?: number
  sampleRate?: number
  year?: number
  artistId?: number
  albumId?: number
  genreId?: number
  keyId?: number
}

// 94-byte fixed header + 21 string offsets + the strings.
function trackRowBuf(o: NewTrackFields): Buffer {
  const fixed = Buffer.alloc(94)
  let p = 0
  const u2 = (v: number): void => { fixed.writeUInt16LE(v & 0xffff, p); p += 2 }
  const u4 = (v: number): void => { fixed.writeUInt32LE(v >>> 0, p); p += 4 }
  const u1 = (v: number): void => { fixed.writeUInt8(v & 0xff, p); p += 1 }
  u2(0x24); u2(0); u4(0)
  u4(o.sampleRate || 44100); u4(0); u4(o.fileSize || 0); u4(0); u2(19048); u2(30967)
  u4(0); u4(o.keyId || 0); u4(0); u4(0); u4(0)
  u4(o.bitrate || 0); u4(0); u4(Math.round(o.bpm * 100))
  u4(o.genreId || 0); u4(o.albumId || 0); u4(o.artistId || 0); u4(o.id)
  u2(0); u2(0); u2(o.year || 0); u2(16); u2(o.durationSec || 0); u2(41); u1(0); u1(0); u2(1); u2(3)

  const strings = new Array<string>(21).fill('')
  strings[14] = o.analyzePath
  strings[17] = o.title
  strings[19] = o.filename
  strings[20] = o.filePath

  const offs = Buffer.alloc(21 * 2)
  const bodies: Buffer[] = []
  let cursor = 94 + 21 * 2
  for (let i = 0; i < 21; i++) {
    offs.writeUInt16LE(cursor, i * 2)
    const b = deviceSqlString(strings[i])
    bodies.push(b)
    cursor += b.length
  }
  return Buffer.concat([fixed, offs, ...bodies])
}

// artist_row: subtype(2) index_shift(2) id(4) 0x03(1) ofs_name_near(1) + name.
function artistRowBuf(id: number, name: string): Buffer {
  const fixed = Buffer.alloc(10)
  fixed.writeUInt16LE(0x60, 0) // subtype (short name offset)
  fixed.writeUInt16LE(0, 2)    // index_shift
  fixed.writeUInt32LE(id >>> 0, 4)
  fixed.writeUInt8(0x03, 8)
  fixed.writeUInt8(10, 9)      // ofs_name_near → name begins at row offset 10
  return Buffer.concat([fixed, deviceSqlString(name)])
}

/** Append a new artist row. Returns a NEW buffer. */
export function addArtistToExportPdb(input: Buffer, id: number, name: string): Buffer {
  const buf = Buffer.from(input)
  const numTables = buf.readUInt32LE(8)
  const tOff = findTable(buf, numTables, PT.ARTISTS)
  if (tOff < 0) throw new Error('artists table not found')
  const row = artistRowBuf(id, name)
  const newIdx = buf.length / PAGE
  const page = buildPage({ pageIndex: newIdx, type: PT.ARTISTS, nextPage: 0xffffffff, rows: [row] })
  const out = Buffer.concat([buf, page])
  const oldLast = tableLastPage(out, tOff)
  setPageNext(out, oldLast, newIdx)
  setTableLastPage(out, tOff, newIdx)
  out.writeUInt32LE(out.length / PAGE, 12)
  return out
}

/** Append a new track row to an export.pdb buffer. Returns a NEW buffer. */
export function addTrackToExportPdb(input: Buffer, fields: NewTrackFields): Buffer {
  const buf = Buffer.from(input)
  const numTables = buf.readUInt32LE(8)
  const tOff = findTable(buf, numTables, PT.TRACKS)
  if (tOff < 0) throw new Error('tracks table not found')
  const row = trackRowBuf(fields)
  if (HEADER + row.length + GROUP_STRIDE > PAGE) throw new Error('track row too large for one page')
  const newIdx = buf.length / PAGE
  const page = buildPage({ pageIndex: newIdx, type: PT.TRACKS, nextPage: 0xffffffff, rows: [row] })
  const out = Buffer.concat([buf, page])
  const oldLast = tableLastPage(out, tOff)
  setPageNext(out, oldLast, newIdx)
  setTableLastPage(out, tOff, newIdx)
  out.writeUInt32LE(out.length / PAGE, 12)
  return out
}

export interface AddTrackOptions {
  /** Absolute path of the source audio file on this computer. */
  audioFilePath: string
  title: string
  bpm: number
  durationSec: number
  /** Stored beatgrid markers (preferred); else a constant grid from bpm is used. */
  beatgrid?: BeatgridMarker[]
  /** Optional 0..1 amplitude peaks for the preview waveform. */
  peaks?: number[]
  bitrate?: number
  year?: number
}

export interface AddTrackResult {
  trackId: number
  deviceFilePath: string
  analyzePath: string
}

/**
 * Add a brand-new track to a USB: copy the audio into /Contents, write its ANLZ
 * (.DAT: beat grid + preview waveform), and insert the track_row referencing
 * both. Backs up export.pdb off-stick first. All writes via Node fs.
 */
export function addTrackToUsb(
  usbRoot: string,
  opts: AddTrackOptions,
  backupPath: string
): AddTrackResult {
  const pdbPath = resolveExportPdb(usbRoot)
  if (!pdbPath) throw new Error(`No export.pdb found at: ${usbRoot}`)

  const original = readFileSync(pdbPath)
  const { tracks } = parseExportPdb(original)
  const newId = tracks.reduce((m: number, t: UsbTrack) => Math.max(m, t.id), 0) + 1

  const hex = newId.toString(16).toUpperCase().padStart(8, '0')

  // 1. Copy audio into /Contents/Offcut.
  // Prefix with the hex track ID so two tracks with the same source filename
  // don't overwrite each other (a CDJ would play the wrong audio otherwise).
  const safeFileName = `${hex}_${basename(opts.audioFilePath)}`
  const deviceFilePath = `/Contents/Offcut/${safeFileName}`
  mkdirSync(join(usbRoot, 'Contents', 'Offcut'), { recursive: true })
  copyFileSync(opts.audioFilePath, join(usbRoot, 'Contents', 'Offcut', safeFileName))

  // 2. Write the ANLZ .DAT.
  const analyzePath = `/PIONEER/USBANLZ/OFCT/${hex}/ANLZ0000.DAT`
  mkdirSync(join(usbRoot, 'PIONEER', 'USBANLZ', 'OFCT', hex), { recursive: true })
  const beats: AnlzBeat[] = opts.beatgrid?.length
    ? beatsFromMarkers(opts.beatgrid, opts.bpm)
    : beatsFromBpm(opts.bpm, opts.durationSec)
  writeFileSync(
    join(usbRoot, analyzePath.replace(/^\//, '')),
    buildDatAnlz({ audioPath: deviceFilePath, beats, peaks: opts.peaks })
  )

  // 3. Back up off-stick, insert the track_row, write the pdb.
  writeFileSync(backupPath, original)
  const out = addTrackToExportPdb(original, {
    id: newId,
    title: opts.title,
    filePath: deviceFilePath,
    filename: safeFileName,
    analyzePath,
    bpm: opts.bpm,
    durationSec: opts.durationSec,
    bitrate: opts.bitrate,
    year: opts.year,
    fileSize: statSync(opts.audioFilePath).size
  })
  writeFileSync(pdbPath, out)
  return { trackId: newId, deviceFilePath, analyzePath }
}

// ── Full playlist sync (M1 link existing + M2a add missing) ──────────────────

/** Loose artist/title key, matching the renderer's matchKey. */
function matchKey(artist: string, title: string): string {
  return `${artist} ${title}`
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface SyncTrackInput {
  artist: string
  title: string
  /** Absolute local audio path (used only if the track isn't already on the USB). */
  audioFilePath: string
  bpm: number
  durationSec: number
  beatgrid?: BeatgridMarker[]
  bitrate?: number
  year?: number
}

export interface SyncPlaylistResult {
  pdbPath: string
  backupPath: string
  playlistId: number
  linked: number
  added: number
  skipped: string[]
  /** True if an existing playlist of the same name was updated rather than created. */
  updatedExisting: boolean
  /** How many entries were newly added to the playlist. */
  newEntries: number
}

export interface SyncProgress {
  playlist: string
  playlistIndex: number
  playlistTotal: number
  track: string
  trackIndex: number
  trackTotal: number
  action: 'link' | 'copy'
}

export interface SyncContext {
  /** When set, the pristine original is backed up here before any change. */
  backupPath?: string
  onProgress?: (p: SyncProgress) => void
  playlistIndex?: number
  playlistTotal?: number
}

/**
 * Sync an Offcut playlist to a USB: tracks already on the stick are linked,
 * tracks that aren't get their audio copied + ANLZ generated + a track_row
 * added — then a playlist referencing all of them (in order) is written.
 * All in one pdb write, with an off-stick backup first.
 */
export function syncPlaylistToUsb(
  usbRoot: string,
  opts: { name: string; tracks: SyncTrackInput[] },
  ctx: SyncContext = {}
): SyncPlaylistResult {
  const pdbPath = resolveExportPdb(usbRoot)
  if (!pdbPath) throw new Error(`No export.pdb found at: ${usbRoot}`)

  const original = readFileSync(pdbPath)
  const backupPath = ctx.backupPath ?? ''
  if (ctx.backupPath) writeFileSync(ctx.backupPath, original) // pristine backup off-stick, first

  const parsed = parseExportPdb(original)
  const usbIndex = new Map<string, number>()
  for (const t of parsed.tracks) {
    const k = matchKey(t.artist, t.title)
    if (k && !usbIndex.has(k)) usbIndex.set(k, t.id)
  }
  const flatPlaylists = (function flat(ns: UsbPlaylistNode[], out: UsbPlaylistNode[] = []): UsbPlaylistNode[] {
    for (const n of ns) { out.push(n); if (n.children) flat(n.children, out) }
    return out
  })(parsed.playlists)

  // Artist index so added tracks carry their artist (needed for display AND so a
  // re-sync matches them instead of duplicating).
  const artistIdByName = new Map<string, number>()
  for (const a of parsed.artists) if (a.name) artistIdByName.set(a.name.toLowerCase(), a.id)
  let nextArtistId = parsed.artists.reduce((m, a) => Math.max(m, a.id), 0) + 1

  let buf: Buffer = original
  let nextTrackId = parsed.tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1
  const resolvedIds: number[] = []
  const skipped: string[] = []
  let linked = 0
  let added = 0

  for (let ti = 0; ti < opts.tracks.length; ti++) {
    const t = opts.tracks[ti]
    const key = matchKey(t.artist, t.title)
    const existing = usbIndex.get(key)
    ctx.onProgress?.({
      playlist: opts.name,
      playlistIndex: ctx.playlistIndex ?? 0,
      playlistTotal: ctx.playlistTotal ?? 1,
      track: `${t.artist} – ${t.title}`,
      trackIndex: ti,
      trackTotal: opts.tracks.length,
      action: existing != null ? 'link' : 'copy'
    })
    if (existing != null) {
      resolvedIds.push(existing)
      linked++
      continue
    }
    // New track: copy audio + ANLZ, insert track_row.
    let fileSize = 0
    try {
      fileSize = statSync(t.audioFilePath).size
    } catch {
      skipped.push(`${t.artist} – ${t.title} (audio not found)`)
      continue
    }
    const id = nextTrackId++

    // Resolve (or create) the artist row so the track carries its performer.
    let artistId = 0
    if (t.artist && t.artist.trim()) {
      const k = t.artist.toLowerCase()
      const existingArtist = artistIdByName.get(k)
      if (existingArtist != null) {
        artistId = existingArtist
      } else {
        artistId = nextArtistId++
        buf = addArtistToExportPdb(buf, artistId, t.artist)
        artistIdByName.set(k, artistId)
      }
    }

    const hex = id.toString(16).toUpperCase().padStart(8, '0')
    const safeFileName = `${hex}_${basename(t.audioFilePath)}`
    const deviceFilePath = `/Contents/Offcut/${safeFileName}`
    mkdirSync(join(usbRoot, 'Contents', 'Offcut'), { recursive: true })
    copyFileSync(t.audioFilePath, join(usbRoot, 'Contents', 'Offcut', safeFileName))
    const analyzePath = `/PIONEER/USBANLZ/OFCT/${hex}/ANLZ0000.DAT`
    mkdirSync(join(usbRoot, 'PIONEER', 'USBANLZ', 'OFCT', hex), { recursive: true })
    const beats: AnlzBeat[] = t.beatgrid?.length
      ? beatsFromMarkers(t.beatgrid, t.bpm)
      : beatsFromBpm(t.bpm, t.durationSec)
    writeFileSync(join(usbRoot, analyzePath.replace(/^\//, '')), buildDatAnlz({ audioPath: deviceFilePath, beats }))

    buf = addTrackToExportPdb(buf, {
      id, title: t.title, filePath: deviceFilePath, filename: safeFileName, analyzePath,
      bpm: t.bpm, durationSec: t.durationSec, bitrate: t.bitrate, year: t.year, fileSize, artistId
    })
    usbIndex.set(key, id)
    resolvedIds.push(id)
    added++
  }

  if (!resolvedIds.length) {
    return { pdbPath, backupPath, playlistId: 0, linked: 0, added: 0, skipped, updatedExisting: false, newEntries: 0 }
  }

  // Incremental sync: if a playlist with this name already exists, add only the
  // tracks not already in it (Rekordbox-style update) instead of duplicating it.
  const existing = flatPlaylists.find((p) => !p.isFolder && p.name === opts.name)
  if (existing) {
    const already = new Set(existing.trackIds ?? [])
    const fresh: number[] = []
    for (const id of resolvedIds) {
      if (!already.has(id)) {
        already.add(id)
        fresh.push(id)
      }
    }
    if (fresh.length) buf = addEntriesToExportPdb(buf, existing.id, fresh, existing.trackIds?.length ?? 0)
    writeFileSync(pdbPath, buf)
    return { pdbPath, backupPath, playlistId: existing.id, linked, added, skipped, updatedExisting: true, newEntries: fresh.length }
  }

  const playlistId = flatPlaylists.reduce((m, p) => Math.max(m, p.id), 0) + 1
  buf = addPlaylistToExportPdb(buf, {
    name: opts.name,
    trackIds: resolvedIds,
    newPlaylistId: playlistId,
    sortOrder: flatPlaylists.length + 1
  })

  writeFileSync(pdbPath, buf)
  return { pdbPath, backupPath, playlistId, linked, added, skipped, updatedExisting: false, newEntries: resolvedIds.length }
}

export interface SyncBatchResult {
  backupPath: string
  playlists: { name: string; linked: number; added: number; newEntries: number; updatedExisting: boolean; skipped: string[] }[]
  totalAdded: number
  totalLinked: number
}

/**
 * Sync several Offcut playlists to a USB in one batch. Backs up once, then
 * processes each playlist sequentially (so tracks added for one are linked by
 * the next), reporting progress via `onProgress`.
 */
export function syncPlaylistsToUsb(
  usbRoot: string,
  playlists: { name: string; tracks: SyncTrackInput[] }[],
  backupPath: string,
  onProgress?: (p: SyncProgress) => void
): SyncBatchResult {
  const pdbPath = resolveExportPdb(usbRoot)
  if (!pdbPath) throw new Error(`No export.pdb found at: ${usbRoot}`)
  // One pristine backup for the whole batch.
  writeFileSync(backupPath, readFileSync(pdbPath))

  const results: SyncBatchResult['playlists'] = []
  let totalAdded = 0
  let totalLinked = 0
  for (let k = 0; k < playlists.length; k++) {
    const pl = playlists[k]
    const r = syncPlaylistToUsb(usbRoot, pl, {
      onProgress,
      playlistIndex: k,
      playlistTotal: playlists.length
    })
    results.push({ name: pl.name, linked: r.linked, added: r.added, newEntries: r.newEntries, updatedExisting: r.updatedExisting, skipped: r.skipped })
    totalAdded += r.added
    totalLinked += r.linked
  }
  return { backupPath, playlists: results, totalAdded, totalLinked }
}

export interface WritePlaylistResult {
  pdbPath: string
  backupPath: string
  playlistId: number
  entryCount: number
}

function flatten(nodes: UsbPlaylistNode[], out: UsbPlaylistNode[] = []): UsbPlaylistNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children) flatten(n.children, out)
  }
  return out
}

/**
 * Write a new playlist to a USB's export.pdb. Assigns a fresh playlist id from
 * the current contents, backs the original up to `backupPath` (which should be
 * OFF the stick — never write extra files to the FAT volume), then writes via
 * Node fs (plain content; no extended attributes that FAT can't store).
 */
export function writePlaylistToUsb(
  usbRoot: string,
  opts: { name: string; trackIds: number[] },
  backupPath: string
): WritePlaylistResult {
  const pdbPath = resolveExportPdb(usbRoot)
  if (!pdbPath) throw new Error(`No export.pdb found at: ${usbRoot}`)
  if (!opts.trackIds.length) throw new Error('No matching tracks to write')

  const original = readFileSync(pdbPath)
  const { playlists } = parseExportPdb(original)
  const flat = flatten(playlists)
  const newPlaylistId = flat.reduce((m, p) => Math.max(m, p.id), 0) + 1
  const sortOrder = flat.length + 1

  // Back up the pristine original off-stick BEFORE touching the volume.
  writeFileSync(backupPath, original)

  const out = addPlaylistToExportPdb(original, {
    name: opts.name,
    trackIds: opts.trackIds,
    newPlaylistId,
    sortOrder
  })
  writeFileSync(pdbPath, out)
  return { pdbPath, backupPath, playlistId: newPlaylistId, entryCount: opts.trackIds.length }
}

// ── Initialize a blank USB as a Rekordbox stick ──────────────────────────────

export interface InitUsbResult {
  pdbPath: string
  created: boolean
}

/**
 * Turn a blank/non-Rekordbox USB into a Rekordbox stick: create the folder
 * skeleton and lay down an empty export.pdb (copied from the bundled template).
 * Refuses to overwrite an existing export.pdb. `templatePath` is the bundled
 * empty-export.pdb (resolved by the caller for dev vs packaged).
 */
export function initializeUsb(usbRoot: string, templatePath: string): InitUsbResult {
  const pioneer = join(usbRoot, 'PIONEER')
  const rbDir = join(pioneer, 'rekordbox')
  const pdbPath = join(rbDir, 'export.pdb')
  if (existsSync(pdbPath)) {
    throw new Error('This USB already has a Rekordbox database — it is already set up.')
  }
  if (!existsSync(templatePath)) throw new Error('Empty database template missing from the app.')

  mkdirSync(rbDir, { recursive: true })
  mkdirSync(join(pioneer, 'USBANLZ'), { recursive: true })
  mkdirSync(join(usbRoot, 'Contents'), { recursive: true })
  // Plain content copy (no extended attributes — FAT can't store them).
  writeFileSync(pdbPath, readFileSync(templatePath))
  return { pdbPath, created: true }
}
