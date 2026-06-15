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
import { join, basename, dirname } from 'path'
import { resolveExportPdb, parseExportPdb } from './reader'
import { buildDatAnlz, buildExtAnlz, build2exAnlz, anlzDirForPath, beatsFromMarkers, beatsFromBpm, type AnlzBeat, type AnlzCue, type AnlzBandColors } from './anlz'
import { analyzeWaveform } from './waveform'
import { buildExportPdb, type PdbTrack, type PdbPlaylist, type PdbArtwork, type HistoryBlobs } from './pdb-builder'
import { readEmbeddedArt, toStickJpeg } from './artwork'
import { patchDevSetting, patchMySetting, patchMySetting2 } from './settings'
import { createHash } from 'node:crypto'
import type { UsbPlaylistNode, UsbTrack } from './types'
import type { BeatgridMarker, CuePoint, UsbDeviceSettings } from '../../../shared/types'

/**
 * Map Offcut cue points to ANLZ cues. Hot cues become numbered hot cues
 * (A=1, B=2…); memory cues and loops become memory cues (hotCueNumber 0). Loops
 * carry their end position so the CDJ restores the loop length.
 */
function toAnlzCues(cues: CuePoint[] | undefined): AnlzCue[] {
  if (!cues?.length) return []
  return cues.map((c) => ({
    hotCueNumber: c.type === 'hotcue' ? Math.max(1, c.index + 1) : 0,
    timeMs: c.positionMs,
    loopTimeMs: c.type === 'loop' ? c.endMs : undefined
  }))
}
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

function buildPage(o: { pageIndex: number; type: number; nextPage: number; rows: Buffer[]; sequence: number }): Buffer {
  const page = Buffer.alloc(PAGE)
  page.writeUInt32LE(0, 0)
  page.writeUInt32LE(o.pageIndex >>> 0, 4)
  page.writeUInt32LE(o.type >>> 0, 8)
  page.writeUInt32LE(o.nextPage >>> 0, 12)
  // Edit sequence. Real Rekordbox NEVER leaves a data page (rows > 0) at
  // sequence 0 — a CDJ validates this and rejects the whole database
  // ("rekordbox Database not found!") if a row-bearing page has sequence 0.
  page.writeUInt32LE(o.sequence >>> 0, 16)
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
  // Transaction state of a cleanly-written page: all n rows touched from index 0
  // (matches a real Rekordbox data page; zeros here look "never written").
  page.writeUInt16LE(n & 0xffff, 32)  // transaction_row_count
  page.writeUInt16LE(0, 34)           // transaction_row_index
  return page
}

// Header field offsets.
const HDR_SEQUENCE_OFF = 20
/** Read the db edit sequence, then advance the header's "next" sequence by one. */
function nextSequence(buf: Buffer): number {
  const seq = buf.readUInt32LE(HDR_SEQUENCE_OFF)
  buf.writeUInt32LE((seq + 1) >>> 0, HDR_SEQUENCE_OFF)
  return seq
}
/** `empty_candidate` — the page Rekordbox would allocate next for this table. */
const setTableEmptyCandidate = (buf: Buffer, off: number, v: number): void => { buf.writeUInt32LE(v >>> 0, off + 4) }

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
  const seq = nextSequence(out)
  for (const p of newPages) buildPage({ pageIndex: p.index, type: p.type, nextPage: 0xffffffff, rows: p.rows, sequence: seq }).copy(out, p.index * PAGE)

  if (entryPageIndices.length) {
    setPageNext(out, entriesLast, entryPageIndices[0])
    for (let i = 0; i < entryPageIndices.length - 1; i++) setPageNext(out, entryPageIndices[i], entryPageIndices[i + 1])
    const entLast = entryPageIndices[entryPageIndices.length - 1]
    setTableLastPage(out, entOff, entLast)
    setTableEmptyCandidate(out, entOff, entLast + 1)
  }
  setPageNext(out, treeLast, treeIdx)
  setTableLastPage(out, treeOff, treeIdx)
  setTableEmptyCandidate(out, treeOff, treeIdx + 1)
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

  const seq = buf.readUInt32LE(HDR_SEQUENCE_OFF)
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
        sequence: seq,
        rows: chunk.map((tid, j) =>
          playlistEntryRow({ entryIndex: startIndex + i + j + 1, trackId: tid, playlistId })
        )
      })
    )
  }
  const out = Buffer.concat([buf, ...pages])
  nextSequence(out) // advance the header's "next" sequence past the pages we wrote
  const oldLast = tableLastPage(out, entOff)
  setPageNext(out, oldLast, pageIndices[0])
  for (let i = 0; i < pageIndices.length - 1; i++) setPageNext(out, pageIndices[i], pageIndices[i + 1])
  const entLast = pageIndices[pageIndices.length - 1]
  setTableLastPage(out, entOff, entLast)
  setTableEmptyCandidate(out, entOff, entLast + 1)
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
  // Per-track "content id" — real Rekordbox writes a unique non-zero value here
  // (never 0). Knuth multiplicative hash of the track id → unique, deterministic.
  const contentId = ((o.id * 2654435761) >>> 0) || 1
  // bitmask 0x000c0700 and the two constants 25013/60146 are what current
  // Rekordbox writes (the kaitai grammar's "always 19048/30967" is an older
  // version). A CDJ-3000 rejects the whole database ("Database not found!") when
  // these don't match — verified by diffing a known-good stick.
  u2(0x24); u2(0); u4(0x000c0700)
  u4(o.sampleRate || 44100); u4(0); u4(o.fileSize || 0); u4(contentId); u2(25013); u2(60146)
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
  const seq = buf.readUInt32LE(HDR_SEQUENCE_OFF)
  const newIdx = buf.length / PAGE
  const page = buildPage({ pageIndex: newIdx, type: PT.ARTISTS, nextPage: 0xffffffff, rows: [row], sequence: seq })
  const out = Buffer.concat([buf, page])
  nextSequence(out)
  const oldLast = tableLastPage(out, tOff)
  setPageNext(out, oldLast, newIdx)
  setTableLastPage(out, tOff, newIdx)
  setTableEmptyCandidate(out, tOff, newIdx + 1)
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
  const seq = buf.readUInt32LE(HDR_SEQUENCE_OFF)
  const newIdx = buf.length / PAGE
  const page = buildPage({ pageIndex: newIdx, type: PT.TRACKS, nextPage: 0xffffffff, rows: [row], sequence: seq })
  const out = Buffer.concat([buf, page])
  nextSequence(out)
  const oldLast = tableLastPage(out, tOff)
  setPageNext(out, oldLast, newIdx)
  setTableLastPage(out, tOff, newIdx)
  setTableEmptyCandidate(out, tOff, newIdx + 1)
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
  /** Camelot key, e.g. "8B"; optional. */
  key?: string
  album?: string
  genre?: string
  /** Hot cues, memory cues and loops from Offcut, written into the ANLZ files. */
  cuePoints?: CuePoint[]
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

// ── Full-rebuild export (CDJ-compatible) ─────────────────────────────────────

export interface ExportToUsbResult {
  backupPath: string | null
  playlists: { name: string; tracks: number }[]
  totalTracks: number
  skipped: string[]
}

/**
 * Export Offcut playlists to a USB by building a COMPLETE, CDJ-compatible
 * export.pdb from scratch (the only structure real players accept — see
 * pdb-builder.ts; the old append-based writer produced files every parser
 * accepted but CDJs rejected). Copies each unique track's audio, writes its
 * ANLZ, lays down export.pdb + the Pioneer settings files. Replaces the stick's
 * database (backed up off-stick first). `today` is YYYY-MM-DD.
 */
export async function exportPlaylistsToUsb(
  usbRoot: string,
  playlists: { name: string; tracks: SyncTrackInput[] }[],
  opts: { settingsDir: string; history: HistoryBlobs; today: string; backupPath?: string; deviceSettings?: UsbDeviceSettings; bandColors?: AnlzBandColors; mode?: 'replace' | 'add'; exportCues?: boolean; onProgress?: (p: SyncProgress) => void }
): Promise<ExportToUsbResult> {
  const rbDir = join(usbRoot, 'PIONEER', 'rekordbox')
  mkdirSync(rbDir, { recursive: true })
  const pdbPath = join(rbDir, 'export.pdb')

  let backupPath: string | null = null
  if (opts.backupPath && existsSync(pdbPath)) {
    writeFileSync(opts.backupPath, readFileSync(pdbPath))
    backupPath = opts.backupPath
  }

  const contentsDir = join(usbRoot, 'Contents', 'Offcut')
  mkdirSync(contentsDir, { recursive: true })

  // Dedup tracks across all playlists by absolute audio path; assign ids 1..N.
  const trackIdByPath = new Map<string, number>()
  const pdbTracks: PdbTrack[] = []
  const skipped: string[] = []
  let nextId = 1

  // Album art, deduped by image bytes (tracks of the same album share one row).
  const artDir = join(usbRoot, 'PIONEER', 'Artwork', '00001')
  const artworkIdByHash = new Map<string, number>()
  const artworks: PdbArtwork[] = []
  let nextArtworkId = 1
  const resolveArtwork = async (audioPath: string): Promise<number> => {
    const raw = await readEmbeddedArt(audioPath)
    if (!raw) return 0
    const hash = createHash('md5').update(raw).digest('hex')
    const existing = artworkIdByHash.get(hash)
    if (existing != null) return existing
    const jpeg = await toStickJpeg(raw)
    if (!jpeg) return 0
    const artId = nextArtworkId++
    const devicePath = `/PIONEER/Artwork/00001/a${artId}.jpg`
    mkdirSync(artDir, { recursive: true })
    writeFileSync(join(artDir, `a${artId}.jpg`), jpeg)
    artworks.push({ id: artId, path: devicePath })
    artworkIdByHash.set(hash, artId)
    return artId
  }

  // "Add" mode: preload the tracks + playlists already on the stick so the sync
  // extends the library instead of replacing it. Existing tracks keep their id,
  // device path and ANLZ (no re-copy/re-analyse); only artwork is re-derived from
  // the on-stick audio so it survives the rebuild.
  const existingByName = new Map<string, number>() // stripped device filename → existing id
  const existingPlaylists: PdbPlaylist[] = []
  if (opts.mode === 'add' && existsSync(pdbPath)) {
    try {
      const prev = parseExportPdb(readFileSync(pdbPath))
      for (const u of prev.tracks) {
        const onStick = join(usbRoot, u.filePath.replace(/^\//, ''))
        let fileSize = 0
        try { fileSize = statSync(onStick).size } catch { continue } // audio gone → drop the row
        const artworkId = await resolveArtwork(onStick)
        pdbTracks.push({
          id: u.id, title: u.title, artist: u.artist, album: u.album || '', genre: u.genre || '', label: '', remixer: '',
          key: u.key || '', sampleRate: 44100, fileSize, bitrate: 0, trackNumber: 0,
          tempo: Math.round((u.bpm || 0) * 100), discNumber: 0, year: u.year || 0, durationSecs: u.durationSeconds || 0,
          fileName: basename(u.filePath), fileExt: basename(u.filePath).split('.').pop() || 'mp3',
          usbPath: u.filePath, analyzePath: u.analyzePath, comment: '', artworkId
        })
        nextId = Math.max(nextId, u.id + 1)
        existingByName.set(basename(u.filePath).replace(/^[0-9a-f]{8}_/i, '').toLowerCase(), u.id)
      }
      for (const p of flatten(prev.playlists)) {
        if (!p.isFolder) existingPlaylists.push({ id: p.id, name: p.name, trackIds: p.trackIds ?? [] })
      }
    } catch { /* unreadable existing db — fall back to a fresh build */ }
  }

  const resolveTrack = async (t: SyncTrackInput): Promise<number | null> => {
    const existing = trackIdByPath.get(t.audioFilePath)
    if (existing != null) return existing
    // Already on the stick (matched by filename)? Reuse it — no copy/analyse.
    const reused = existingByName.get(basename(t.audioFilePath).toLowerCase())
    if (reused != null) { trackIdByPath.set(t.audioFilePath, reused); return reused }
    let fileSize = 0
    try {
      fileSize = statSync(t.audioFilePath).size
    } catch {
      skipped.push(`${t.artist} – ${t.title} (audio not found)`)
      return null
    }
    const id = nextId++
    const hex = id.toString(16).toUpperCase().padStart(8, '0')
    const safeFileName = `${hex}_${basename(t.audioFilePath)}`
    const deviceFilePath = `/Contents/Offcut/${safeFileName}`
    copyFileSync(t.audioFilePath, join(contentsDir, safeFileName))

    // Spectral analysis for true-colour waveforms (bass/mid/treble). Falls back
    // to a flat waveform if decoding fails — never aborts the export.
    const bands = (await analyzeWaveform(t.audioFilePath, t.durationSec)) ?? undefined

    // ANLZ files MUST live at the hash-computed path — the CDJ recomputes the
    // path from the audio file's USB path and ignores analyze_path. Write both
    // .DAT and .EXT (the CDJ-3000 re-analyses every track without the .EXT).
    const anlzDir = anlzDirForPath(deviceFilePath)
    const analyzePath = `/${anlzDir}/ANLZ0000.DAT`
    mkdirSync(join(usbRoot, anlzDir), { recursive: true })
    const beats: AnlzBeat[] = t.beatgrid?.length ? beatsFromMarkers(t.beatgrid, t.bpm) : beatsFromBpm(t.bpm, t.durationSec)
    // Cue export is opt-in (beta): cue sections now sit AFTER every waveform in
    // the .EXT (see buildExtAnlz) so they can't block waveform parsing, but this
    // is still pending validation on real hardware — hence the toggle.
    const anlzCues = opts.exportCues ? toAnlzCues(t.cuePoints) : ([] as AnlzCue[])
    const anlzOpts = { audioPath: deviceFilePath, beats, durationSecs: t.durationSec, bands, bandColors: opts.bandColors, cues: anlzCues }
    writeFileSync(join(usbRoot, anlzDir, 'ANLZ0000.DAT'), buildDatAnlz(anlzOpts))
    writeFileSync(join(usbRoot, anlzDir, 'ANLZ0000.EXT'), buildExtAnlz(anlzOpts))
    // .2EX holds the CDJ-3000's native 3-band waveforms (only when we have bands).
    const twoEx = build2exAnlz(anlzOpts)
    if (twoEx) writeFileSync(join(usbRoot, anlzDir, 'ANLZ0000.2EX'), twoEx)

    const artworkId = await resolveArtwork(t.audioFilePath)

    trackIdByPath.set(t.audioFilePath, id)
    pdbTracks.push({
      id, title: t.title, artist: t.artist, album: t.album || '', genre: t.genre || '', label: '', remixer: '',
      key: t.key || '', sampleRate: 44100, fileSize, bitrate: t.bitrate || 0, trackNumber: 0,
      tempo: Math.round((t.bpm || 0) * 100), discNumber: 0, year: t.year || 0, durationSecs: t.durationSec || 0,
      fileName: safeFileName, fileExt: basename(t.audioFilePath).split('.').pop() || 'mp3',
      usbPath: deviceFilePath, analyzePath, comment: '', artworkId
    })
    return id
  }

  // Start from the existing playlists in "add" mode; a synced playlist with the
  // same name replaces its contents, a new name is appended.
  const pdbPlaylists: PdbPlaylist[] = [...existingPlaylists]
  let nextPlaylistId = pdbPlaylists.reduce((m, p) => Math.max(m, p.id), 0) + 1
  const resultPlaylists: { name: string; tracks: number }[] = []
  for (const [pi, pl] of playlists.entries()) {
    const ids: number[] = []
    for (const [ti, t] of pl.tracks.entries()) {
      opts.onProgress?.({
        playlist: pl.name, playlistIndex: pi, playlistTotal: playlists.length,
        track: `${t.artist} – ${t.title}`, trackIndex: ti, trackTotal: pl.tracks.length,
        action: trackIdByPath.has(t.audioFilePath) ? 'link' : 'copy'
      })
      const id = await resolveTrack(t)
      if (id != null) ids.push(id)
    }
    const same = pdbPlaylists.find((p) => p.name === pl.name)
    if (same) same.trackIds = ids
    else pdbPlaylists.push({ id: nextPlaylistId++, name: pl.name, trackIds: ids })
    resultPlaylists.push({ name: pl.name, tracks: ids.length })
  }

  writeFileSync(pdbPath, buildExportPdb(pdbTracks, pdbPlaylists, opts.history, opts.today, artworks))
  writeRekordboxStructure(usbRoot, opts.settingsDir, opts.deviceSettings)

  return { backupPath, playlists: resultPlaylists, totalTracks: pdbTracks.length, skipped }
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
 * The generic Pioneer settings files a real Rekordbox export carries in
 * /PIONEER. A CDJ refuses a stick that lacks them ("rekordbox Database not
 * found!"), even when export.pdb is perfectly valid — so we must lay them down.
 * Bundled alongside empty-export.pdb in the template dir.
 */
const SETTING_FILES = ['DEVSETTING.DAT', 'MYSETTING.DAT', 'MYSETTING2.DAT', 'DJMMYSETTING.DAT']
const SETTING_PATCHERS: Record<string, (t: Buffer, s: UsbDeviceSettings) => Buffer> = {
  'DEVSETTING.DAT': patchDevSetting,
  'MYSETTING.DAT': patchMySetting,
  'MYSETTING2.DAT': patchMySetting2
}

/** Folders a real Rekordbox export creates under /PIONEER (empty is fine). */
const PIONEER_DIRS = ['CDJ', 'MPJ', 'Artwork']

/**
 * Lay down the Pioneer settings files + folders a CDJ requires to accept a
 * stick. Idempotent; safe to call on an already-initialised USB. `settingsDir`
 * is the bundled template directory (where the *SETTING.DAT files live).
 */
export function writeRekordboxStructure(usbRoot: string, settingsDir: string, deviceSettings?: UsbDeviceSettings): void {
  const pioneer = join(usbRoot, 'PIONEER')
  for (const name of SETTING_FILES) {
    const src = join(settingsDir, name)
    const dst = join(pioneer, name)
    if (!existsSync(src)) continue
    const patcher = deviceSettings && SETTING_PATCHERS[name]
    try {
      // The editable settings live in DEVSETTING/MYSETTING/MYSETTING2 — always
      // (re)write those with the chosen values; the rest are copied once if absent.
      if (patcher) {
        writeFileSync(dst, patcher(readFileSync(src), deviceSettings))
      } else if (!existsSync(dst)) {
        writeFileSync(dst, readFileSync(src))
      }
    } catch { /* FAT hiccup — non-fatal */ }
  }
  for (const d of PIONEER_DIRS) {
    try { mkdirSync(join(pioneer, d), { recursive: true }) } catch { /* ignore */ }
  }
}

/**
 * Turn a blank/non-Rekordbox USB into a Rekordbox stick: create the folder
 * skeleton, lay down an empty export.pdb (copied from the bundled template),
 * and write the Pioneer settings files/folders a CDJ requires.
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
  // The *SETTING.DAT files live next to the template; a CDJ needs them.
  writeRekordboxStructure(usbRoot, dirname(templatePath))
  return { pdbPath, created: true }
}
