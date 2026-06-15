// Build a CDJ-compatible Rekordbox `export.pdb` (DeviceSQL) from scratch.
//
// This is a faithful TypeScript port of the algorithm in morizkraemer/fourfour's
// pioneer-usb-writer (`src/writer/pdb.rs`) — reverse-engineered + hardware-tested
// against a CDJ-3000 (firmware 3.19). Our previous "empty template + append one
// row per page" approach produced files that parse in every open-source parser
// (rekordcrate) yet the CDJ rejects with "rekordbox Database not found", because
// the player checks structural details no lenient parser does:
//   • each table's HEADER/index page carries a fixed fill pattern (0x1FFFFFF8)
//     plus per-table sentinels (Tracks/History get 0x1FFF0001 + 0x10/0x140);
//   • the HISTORY tables (0x11/0x12/0x13) must contain real content (we embed
//     known-good reference pages from a genuine export);
//   • last page of each chain points at empty_candidate, never 0xFFFFFFFF;
//   • data-page header fields follow exact formulas.
//
// Pages are 4096 bytes. Page 0 is the file header (table pointers). Pages 1-40
// hold each table's header + first data page; overflow pages start at 52.

const PAGE = 4096
const HEAP = 0x28

export interface PdbTrack {
  id: number
  title: string
  artist: string
  album: string
  genre: string
  label: string
  remixer: string
  /** Camelot key, e.g. "8B"; "" for none. */
  key: string
  sampleRate: number
  fileSize: number
  bitrate: number
  trackNumber: number
  /** BPM × 100. */
  tempo: number
  discNumber: number
  year: number
  durationSecs: number
  /** File extension source (for file_type) + basename (for filename). */
  fileName: string
  fileExt: string
  /** Device-relative audio path, e.g. /Contents/Offcut/x.mp3 */
  usbPath: string
  /** Device-relative ANLZ path string (CDJ ignores it, but real exports store one). */
  analyzePath: string
  comment: string
  /** Row id in the artwork table (0 = no album art). */
  artworkId?: number
}

/** An album-art row: its id and the device-relative path to the JPEG. */
export interface PdbArtwork {
  id: number
  path: string
}

export interface PdbPlaylist {
  id: number
  name: string
  trackIds: number[]
}

export interface HistoryBlobs {
  p36: Buffer // history_playlists
  p38: Buffer // history_entries
  p40: Buffer // history
}

// ── DeviceSQL string encoding ────────────────────────────────────────────────
function encodeString(s: string): Buffer {
  if (s.length === 0) return Buffer.from([0x03])
  const isAscii = /^[\x00-\x7F]*$/.test(s)
  if (!isAscii) {
    const body = Buffer.from(s, 'utf16le')
    const head = Buffer.alloc(4)
    head.writeUInt8(0x90, 0)
    head.writeUInt16LE(body.length + 4, 1)
    head.writeUInt8(0, 3)
    return Buffer.concat([head, body])
  }
  const bytes = Buffer.from(s, 'ascii')
  if (bytes.length <= 126) {
    return Buffer.concat([Buffer.from([((bytes.length + 1) << 1) | 1]), bytes])
  }
  const head = Buffer.alloc(4)
  head.writeUInt8(0x40, 0)
  head.writeUInt16LE(bytes.length + 4, 1)
  head.writeUInt8(0, 3)
  return Buffer.concat([head, bytes])
}

function alignTo4(parts: number[]): void {
  while (parts.length % 4 !== 0) parts.push(0)
}

// ── Page layout (matches rekordbox CDJ-3000 exports) ─────────────────────────
interface Layout { type: number; header: number; data: number; emptyCand: number; last: number }
const LAYOUTS: Layout[] = [
  { type: 0x00, header: 1,  data: 2,  emptyCand: 49, last: 2  }, // tracks
  { type: 0x01, header: 3,  data: 4,  emptyCand: 4,  last: 3  }, // genres
  { type: 0x02, header: 5,  data: 6,  emptyCand: 47, last: 6  }, // artists
  { type: 0x03, header: 7,  data: 8,  emptyCand: 48, last: 8  }, // albums
  { type: 0x04, header: 9,  data: 0,  emptyCand: 10, last: 9  }, // labels
  { type: 0x05, header: 11, data: 12, emptyCand: 12, last: 11 }, // keys
  { type: 0x06, header: 13, data: 14, emptyCand: 42, last: 14 }, // colors
  { type: 0x07, header: 15, data: 16, emptyCand: 46, last: 16 }, // playlist_tree
  { type: 0x08, header: 17, data: 18, emptyCand: 51, last: 18 }, // playlist_entries
  { type: 0x09, header: 19, data: 0,  emptyCand: 20, last: 19 }, // unknown09
  { type: 0x0a, header: 21, data: 0,  emptyCand: 22, last: 21 }, // unknown0a
  { type: 0x0b, header: 23, data: 0,  emptyCand: 24, last: 23 }, // unknown0b
  { type: 0x0c, header: 25, data: 0,  emptyCand: 26, last: 25 }, // unknown0c
  { type: 0x0d, header: 27, data: 28, emptyCand: 50, last: 28 }, // artwork
  { type: 0x0e, header: 29, data: 0,  emptyCand: 30, last: 29 }, // unknown0e
  { type: 0x0f, header: 31, data: 0,  emptyCand: 32, last: 31 }, // unknown0f
  { type: 0x10, header: 33, data: 34, emptyCand: 43, last: 34 }, // columns
  { type: 0x11, header: 35, data: 36, emptyCand: 44, last: 36 }, // history_playlists
  { type: 0x12, header: 37, data: 38, emptyCand: 45, last: 38 }, // history_entries
  { type: 0x13, header: 39, data: 40, emptyCand: 41, last: 40 }  // history
]

// ── Row → page chunking (dense packing) ──────────────────────────────────────
interface Rows { heap: Buffer; offsets: number[] }
interface Chunk { heap: Buffer; offsets: number[] }

/** Row-group footer size (full-stride, grammar-standard: 0x24 bytes per group). */
function rowGroupBytes(numRows: number): number {
  return Math.max(1, Math.ceil(numRows / 16)) * 0x24
}

function splitIntoPages(rows: Rows): Chunk[] {
  const { heap, offsets } = rows
  if (offsets.length === 0) return [{ heap: Buffer.alloc(0), offsets: [] }]
  const chunks: Chunk[] = []
  let start = 0
  while (start < offsets.length) {
    let end = start
    for (;;) {
      const cand = end + 1
      if (cand > offsets.length) break
      const rg = rowGroupBytes(cand - start)
      const heapStart = offsets[start]
      const heapEnd = cand < offsets.length ? offsets[cand] : heap.length
      if (heapEnd - heapStart + rg > PAGE - HEAP) break
      end = cand
    }
    if (end === start) end = start + 1 // oversized single row — force it
    const base = offsets[start]
    const heapEnd = end < offsets.length ? offsets[end] : heap.length
    chunks.push({
      heap: heap.subarray(base, heapEnd),
      offsets: offsets.slice(start, end).map((o) => o - base)
    })
    start = end
  }
  return chunks
}

// ── Page writers ─────────────────────────────────────────────────────────────
function writePageHeader(page: Buffer, pageIndex: number, type: number, nextPage: number, numRows: number, flags: number, sequence: number, unknown7: number): void {
  const isHeader = flags === 0x64
  const numRowsSmall = Math.min(numRows, 255)
  const unk3 = ((numRows % 8) * 0x20) & 0xff
  let unk4 = 0
  if (numRows >= 10) {
    const g = Math.ceil(numRows / 16)
    unk4 = type === 0x10 ? g + 1 : g
  }
  let numRowsLarge: number, unknown5: number, unknown6: number
  if (isHeader) { numRowsLarge = 0x1fff; unknown5 = 0x1fff; unknown6 = 0x03ec }
  else if (type === 0x10) { numRowsLarge = 0; unknown5 = numRows; unknown6 = 0 }
  else { numRowsLarge = numRows === 0 ? 0 : numRows - 1; unknown5 = 0x0001; unknown6 = 0 }

  page.writeUInt32LE(0, 0)
  page.writeUInt32LE(pageIndex >>> 0, 4)
  page.writeUInt32LE(type >>> 0, 8)
  page.writeUInt32LE(nextPage >>> 0, 12)
  page.writeUInt32LE(sequence >>> 0, 16)
  page.writeUInt32LE(0, 20)
  page.writeUInt8(numRowsSmall, 24)
  page.writeUInt8(unk3, 25)
  page.writeUInt8(unk4 & 0xff, 26)
  page.writeUInt8(flags, 27)
  // free/used (28,30) patched by caller
  page.writeUInt16LE(unknown5 & 0xffff, 32)
  page.writeUInt16LE(numRowsLarge & 0xffff, 34)
  page.writeUInt16LE(unknown6 & 0xffff, 36)
  page.writeUInt16LE(unknown7 & 0xffff, 38)
}

/** Grammar-standard row-group footer (0x24 stride per group, built from page end). */
function writeRowGroups(page: Buffer, numRows: number, offsets: number[]): void {
  const numGroups = Math.max(1, Math.ceil(numRows / 16))
  for (let g = 0; g < numGroups; g++) {
    const base = PAGE - g * 0x24
    let present = 0
    for (let r = 0; r < 16; r++) if (g * 16 + r < numRows) present |= 1 << r
    page.writeUInt16LE(present, base - 4)
    for (let r = 0; r < 16; r++) {
      const gi = g * 16 + r
      page.writeUInt16LE(gi < numRows ? offsets[gi] & 0xffff : 0, base - 6 - 2 * r)
    }
  }
}

function buildHeaderPage(pageIndex: number, type: number, nextPage: number, firstDataPage: number | null): Buffer {
  const page = Buffer.alloc(PAGE)
  let seq = 1, unk7 = 0
  if (type === 0x00) { seq = 44; unk7 = 1 }
  else if (type === 0x13) { seq = 17; unk7 = 1 }
  writePageHeader(page, pageIndex, type, nextPage, 0, 0x64, seq, unk7)

  let p = HEAP
  page.writeUInt32LE(pageIndex >>> 0, p); p += 4
  page.writeUInt32LE((firstDataPage ?? 0x03ffffff) >>> 0, p); p += 4
  page.writeUInt32LE(0x03ffffff, p); p += 4
  page.writeUInt32LE(0, p); p += 4
  if (type === 0x00 || type === 0x13) {
    page.writeUInt32LE(0x1fff0001, p); p += 4
    page.writeUInt32LE(type === 0x00 ? 0x00000010 : 0x00000140, p); p += 4
  } else {
    page.writeUInt32LE(0x1fff0000, p); p += 4
  }
  // Fill the rest with the 0x1FFFFFF8 pattern, leaving the final 20 bytes zero.
  const remaining = PAGE - p - 20
  const count = Math.floor(remaining / 4)
  for (let i = 0; i < count; i++) { page.writeUInt32LE(0x1ffffff8, p); p += 4 }
  // free_size/used_size = 0 (already zero)
  return page
}

function buildDataPage(pageIndex: number, type: number, nextPage: number, heap: Buffer, offsets: number[], sequence: number): Buffer {
  const page = Buffer.alloc(PAGE)
  const numRows = offsets.length
  writePageHeader(page, pageIndex, type, nextPage, numRows, 0x24, sequence, 0)
  heap.copy(page, HEAP)
  writeRowGroups(page, numRows, offsets)
  const used = heap.length
  const free = PAGE - HEAP - used - rowGroupBytes(numRows)
  page.writeUInt16LE(Math.max(0, free) & 0xffff, 28)
  page.writeUInt16LE(used & 0xffff, 30)
  return page
}

function buildBlankDataPage(pageIndex: number, type: number, nextPage: number): Buffer {
  const page = Buffer.alloc(PAGE)
  writePageHeader(page, pageIndex, type, nextPage, 0, 0x24, 1, 0)
  page.writeUInt16LE((PAGE - HEAP) & 0xffff, 28) // all free
  return page
}

// ── Row builders ─────────────────────────────────────────────────────────────
function nameRows(values: string[]): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  values.forEach((v, i) => {
    offsets.push(parts.length)
    const id = Buffer.alloc(4); id.writeUInt32LE(i + 1, 0)
    parts.push(...id, ...encodeString(v))
    alignTo4(parts)
  })
  return { heap: Buffer.from(parts), offsets }
}

// artwork_row: u4 id + DeviceSQL path string (inline). Ids come pre-assigned.
function artworkRows(arts: PdbArtwork[]): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  for (const a of arts) {
    offsets.push(parts.length)
    const id = Buffer.alloc(4); id.writeUInt32LE(a.id, 0)
    parts.push(...id, ...encodeString(a.path))
    alignTo4(parts)
  }
  return { heap: Buffer.from(parts), offsets }
}

function artistRows(values: string[]): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  values.forEach((a, i) => {
    const rowStart = parts.length
    offsets.push(rowStart)
    const fixed = Buffer.alloc(10)
    fixed.writeUInt16LE(0x0060, 0)
    fixed.writeUInt16LE((i * 0x20) & 0xffff, 2)
    fixed.writeUInt32LE(i + 1, 4)
    fixed.writeUInt8(0x03, 8)
    fixed.writeUInt8(0x0a, 9)
    parts.push(...fixed, ...encodeString(a))
    while (parts.length - rowStart < 28) parts.push(0)
  })
  return { heap: Buffer.from(parts), offsets }
}

function albumRows(values: string[], albumArtistId: Map<string, number>): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  values.forEach((a, i) => {
    const rowStart = parts.length
    offsets.push(rowStart)
    // Album row: u16 magic, u16 index_shift, u32 unknown2, u32 artist_id,
    // u32 id, u32 unknown3, u8 unknown4, u8 ofs_name → 22-byte fixed part, then
    // the name string at offset 0x16. (The unknown3 u32 was previously missing,
    // which left ofs_name pointing past the fixed part and corrupted the page.)
    const fixed = Buffer.alloc(22)
    fixed.writeUInt16LE(0x0080, 0)
    fixed.writeUInt16LE((i * 0x20) & 0xffff, 2)
    fixed.writeUInt32LE(0, 4) // unknown2
    fixed.writeUInt32LE(albumArtistId.get(a.toLowerCase()) ?? 0, 8) // artist_id
    fixed.writeUInt32LE(i + 1, 12) // id
    fixed.writeUInt32LE(0, 16) // unknown3
    fixed.writeUInt8(0x03, 20) // unknown4
    fixed.writeUInt8(0x16, 21) // ofs_name → name at offset 22
    parts.push(...fixed, ...encodeString(a))
    while (parts.length - rowStart < 40) parts.push(0)
  })
  return { heap: Buffer.from(parts), offsets }
}

function keyRows(): Rows {
  const keys = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B', 'Cm', 'Dbm', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'Abm', 'Am', 'Bbm', 'Bm']
  const parts: number[] = []
  const offsets: number[] = []
  keys.forEach((name, i) => {
    offsets.push(parts.length)
    const id = Buffer.alloc(8); id.writeUInt32LE(i + 1, 0); id.writeUInt32LE(i + 1, 4)
    parts.push(...id, ...encodeString(name))
    alignTo4(parts)
  })
  return { heap: Buffer.from(parts), offsets }
}

function colorRows(): Rows {
  const colors: [number, string][] = [[1, 'Pink'], [2, 'Red'], [3, 'Orange'], [4, 'Yellow'], [5, 'Green'], [6, 'Aqua'], [7, 'Blue'], [8, 'Purple']]
  const parts: number[] = []
  const offsets: number[] = []
  for (const [id, name] of colors) {
    offsets.push(parts.length)
    const fixed = Buffer.alloc(8)
    fixed.writeUInt16LE(id, 5) // color_row: 5 bytes pad, u2 id, u1, name
    parts.push(...fixed, ...encodeString(name))
    alignTo4(parts)
  }
  return { heap: Buffer.from(parts), offsets }
}

const COLUMNS: [number, number, string][] = [
  [1, 0x0080, '￺GENRE￻'], [2, 0x0081, '￺ARTIST￻'], [3, 0x0082, '￺ALBUM￻'],
  [4, 0x0083, '￺TRACK￻'], [5, 0x0085, '￺BPM￻'], [6, 0x0086, '￺RATING￻'],
  [7, 0x0087, '￺YEAR￻'], [8, 0x0088, '￺REMIXER￻'], [9, 0x0089, '￺LABEL￻'],
  [10, 0x008a, '￺ORIGINAL ARTIST￻'], [11, 0x008b, '￺KEY￻'], [12, 0x008d, '￺CUE￻'],
  [13, 0x008e, '￺COLOR￻'], [14, 0x0092, '￺TIME￻'], [15, 0x0093, '￺BITRATE￻'],
  [16, 0x0094, '￺FILE NAME￻'], [17, 0x0084, '￺PLAYLIST￻'], [18, 0x0098, '￺HOT CUE BANK￻'],
  [19, 0x0095, '￺HISTORY￻'], [20, 0x0091, '￺SEARCH￻'], [21, 0x0096, '￺COMMENTS￻'],
  [22, 0x008c, '￺DATE ADDED￻'], [23, 0x0097, '￺DJ PLAY COUNT￻'], [24, 0x0090, '￺FOLDER￻'],
  [25, 0x00a1, '￺DEFAULT￻'], [26, 0x00a2, '￺ALPHABET￻'], [27, 0x00aa, '￺MATCHING￻']
]
function columnRows(): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  for (const [id, colType, name] of COLUMNS) {
    offsets.push(parts.length)
    const fixed = Buffer.alloc(4); fixed.writeUInt16LE(id, 0); fixed.writeUInt16LE(colType, 2)
    parts.push(...fixed, ...encodeString(name))
    alignTo4(parts)
  }
  return { heap: Buffer.from(parts), offsets }
}

function playlistTreeRows(playlists: PdbPlaylist[]): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  playlists.forEach((p, i) => {
    offsets.push(parts.length)
    const fixed = Buffer.alloc(20)
    fixed.writeUInt32LE(0, 0)        // parent_id
    fixed.writeUInt32LE(0, 4)
    fixed.writeUInt32LE(i, 8)        // sort_order
    fixed.writeUInt32LE(p.id, 12)   // id
    fixed.writeUInt32LE(0, 16)      // is_folder
    parts.push(...fixed, ...encodeString(p.name))
    alignTo4(parts)
  })
  return { heap: Buffer.from(parts), offsets }
}

function playlistEntryRows(playlists: PdbPlaylist[]): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  let entryIdx = 1
  for (const pl of playlists) {
    for (const tid of pl.trackIds) {
      offsets.push(parts.length)
      const row = Buffer.alloc(12)
      row.writeUInt32LE(entryIdx++, 0)
      row.writeUInt32LE(tid, 4)
      row.writeUInt32LE(pl.id, 8)
      parts.push(...row)
    }
  }
  return { heap: Buffer.from(parts), offsets }
}

function keyNameToId(key: string): number {
  // Standard Camelot: "A" = minor, "B" = major. rekordbox key_id 1-12 = major
  // (C,Db,..,B), 13-24 = minor (Cm,..,Bm). Maps e.g. 8B→C(1), 8A→Am(22).
  if (!key) return 0
  const major = [12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]   // 1B..12B
  const minor = [21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19, 14] // 1A..12A
  const m = /^(\d{1,2})([AB])$/i.exec(key.trim())
  if (!m) return 0
  const n = Number(m[1])
  if (n < 1 || n > 12) return 0
  return m[2].toUpperCase() === 'B' ? major[n - 1] : minor[n - 1]
}

function fileTypeFor(ext: string): number {
  switch (ext.toLowerCase()) {
    case 'mp3': return 0x01
    case 'm4a': case 'mp4': case 'aac': return 0x04
    case 'flac': return 0x05
    case 'wav': return 0x0b
    case 'aiff': case 'aif': return 0x0c
    default: return 0x00
  }
}

function trackRows(tracks: PdbTrack[], ids: { artist: Map<string, number>; album: Map<string, number>; genre: Map<string, number>; label: Map<string, number>; remixer: Map<string, number> }, today: string): Rows {
  const parts: number[] = []
  const offsets: number[] = []
  tracks.forEach((t, idx) => {
    const rowStart = parts.length
    offsets.push(rowStart)
    const f = Buffer.alloc(0x5e)
    let p = 0
    const u2 = (v: number): void => { f.writeUInt16LE(v & 0xffff, p); p += 2 }
    const u4 = (v: number): void => { f.writeUInt32LE(v >>> 0, p); p += 4 }
    const u1 = (v: number): void => { f.writeUInt8(v & 0xff, p); p += 1 }
    u2(0x0024); u2((idx * 0x20) & 0xffff); u4(0x0700)
    u4(t.sampleRate || 44100); u4(0); u4(Math.min(t.fileSize, 0xffffffff) >>> 0)
    u4(((t.id + 5) | 0x100) >>> 0); u2(0xe5b6); u2(0x6a76)
    u4(t.artworkId ?? 0) // artwork_id
    u4(keyNameToId(t.key)); u4(0); u4(ids.label.get(t.label.toLowerCase()) ?? 0); u4(ids.remixer.get(t.remixer.toLowerCase()) ?? 0)
    u4(t.bitrate || 0); u4(t.trackNumber || 0); u4(t.tempo || 0)
    u4(ids.genre.get(t.genre.toLowerCase()) ?? 0); u4(ids.album.get(t.album.toLowerCase()) ?? 0); u4(ids.artist.get(t.artist.toLowerCase()) ?? 0); u4(t.id)
    u2(t.discNumber || 0); u2(0); u2(t.year || 0); u2(16); u2(Math.round(t.durationSecs) || 0); u2(0x0029); u1(0); u1(0); u2(fileTypeFor(t.fileExt)); u2(0x0003)

    const stringDataStart = 0x5e + 21 * 2
    const stringOffsets = new Array<number>(21).fill(0)
    const strData: number[] = []
    const add = (i: number, data: number[] | Buffer): void => {
      stringOffsets[i] = stringDataStart + strData.length
      strData.push(...data)
    }
    add(0, [0x03]); add(1, [0x03]); add(2, encodeString('3')); add(3, [0x05, 0x01]); add(4, [0x03])
    add(5, [0x03]); add(6, [0x03]); add(7, encodeString('ON')); add(8, [0x03]); add(9, [0x03])
    add(10, encodeString(today))
    add(11, t.year > 0 ? encodeString(`${t.year}-01-01`) : [0x03])
    add(12, [0x03]); add(13, [0x03])
    add(14, encodeString(t.analyzePath)); add(15, encodeString(today))
    add(16, t.comment ? encodeString(t.comment) : [0x03])
    add(17, encodeString(t.title)); add(18, [0x03])
    add(19, encodeString(t.fileName)); add(20, encodeString(t.usbPath))

    const offs = Buffer.alloc(42)
    stringOffsets.forEach((o, i) => offs.writeUInt16LE(o & 0xffff, i * 2))
    parts.push(...f, ...offs, ...strData)
    while ((parts.length - rowStart) % 4 !== 0) parts.push(0)
    while (parts.length - rowStart < 344) parts.push(0)
  })
  return { heap: Buffer.from(parts), offsets }
}

// ── Orchestration ────────────────────────────────────────────────────────────
function dedupCi(values: string[]): { unique: string[]; map: Map<string, number> } {
  const map = new Map<string, number>()
  const unique: string[] = []
  for (const v of values) {
    const k = v.toLowerCase()
    if (!map.has(k)) { map.set(k, unique.length + 1); unique.push(v) }
  }
  return { unique, map }
}

/** Build a complete CDJ-compatible export.pdb. `today` is YYYY-MM-DD. */
export function buildExportPdb(
  tracks: PdbTrack[],
  playlists: PdbPlaylist[],
  history: HistoryBlobs,
  today: string,
  artworks: PdbArtwork[] = []
): Buffer {
  const artists = dedupCi(tracks.map((t) => t.artist))
  const albums = dedupCi(tracks.map((t) => t.album).filter(Boolean))
  const genres = dedupCi(tracks.map((t) => t.genre).filter(Boolean))
  const labels = dedupCi(tracks.map((t) => t.label).filter(Boolean))

  const albumArtistId = new Map<string, number>()
  for (const t of tracks) {
    const aid = artists.map.get(t.artist.toLowerCase())
    if (aid != null && t.album) { const k = t.album.toLowerCase(); if (!albumArtistId.has(k)) albumArtistId.set(k, aid) }
  }

  // Remixers fold into the artist table.
  const allArtists = artists.unique.slice()
  const remixerMap = new Map<string, number>()
  let nextArtistId = artists.unique.length + 1
  for (const t of tracks) {
    if (!t.remixer) continue
    const k = t.remixer.toLowerCase()
    if (remixerMap.has(k)) continue
    const existing = artists.map.get(k)
    if (existing != null) remixerMap.set(k, existing)
    else { remixerMap.set(k, nextArtistId++); allArtists.push(t.remixer) }
  }

  const ids = { artist: artists.map, album: albums.map, genre: genres.map, label: labels.map, remixer: remixerMap }

  // Build per-table rows → chunks.
  const data = new Map<number, { chunks: Chunk[]; seq: number }>()
  const set = (type: number, rows: Rows, base: number): void => {
    data.set(type, { chunks: splitIntoPages(rows), seq: base + Math.max(0, rows.offsets.length - 1) * 5 })
  }
  set(0x00, trackRows(tracks, ids, today), 10)
  set(0x01, nameRows(genres.unique), 2)
  set(0x02, artistRows(allArtists), 7)
  set(0x03, albumRows(albums.unique, albumArtistId), 9)
  set(0x04, nameRows(labels.unique), 4)
  data.set(0x05, { chunks: splitIntoPages(keyRows()), seq: 1 })
  data.set(0x06, { chunks: splitIntoPages(colorRows()), seq: 8 + 7 * 5 })
  set(0x07, playlistTreeRows(playlists), 6)
  set(0x08, playlistEntryRows(playlists), 11)
  if (artworks.length) set(0x0d, artworkRows(artworks), 5)
  else data.set(0x0d, { chunks: [{ heap: Buffer.alloc(0), offsets: [] }], seq: 5 }) // artwork (none)
  data.set(0x10, { chunks: splitIntoPages(columnRows()), seq: 3 })

  // Allocate overflow pages (>1 data page) starting at 52.
  let nextOverflow = 52
  const overflow = new Map<number, { pages: number[]; last: number; ec: number }>()
  for (const L of LAYOUTS) {
    const d = data.get(L.type)
    if (!d) continue
    const nonEmpty = d.chunks.length > 0 && d.chunks.some((c) => c.offsets.length > 0)
    if (L.data === 0) {
      if (nonEmpty) {
        const pages = d.chunks.map(() => nextOverflow++)
        overflow.set(L.type, { pages, last: pages[pages.length - 1], ec: nextOverflow++ })
      }
      continue
    }
    const extra = Math.max(0, d.chunks.length - 1)
    if (extra > 0) {
      const pages = [L.data]
      for (let i = 0; i < extra; i++) pages.push(nextOverflow++)
      overflow.set(L.type, { pages, last: pages[pages.length - 1], ec: nextOverflow++ })
    }
  }

  const totalPages = Math.max(41, nextOverflow)
  const buf = Buffer.alloc(totalPages * PAGE)

  // Page 0 header.
  let maxSeq = 0
  for (const d of data.values()) maxSeq = Math.max(maxSeq, d.seq)
  buf.writeUInt32LE(0, 0)
  buf.writeUInt32LE(PAGE, 4)
  buf.writeUInt32LE(LAYOUTS.length, 8)
  buf.writeUInt32LE(nextOverflow, 12) // next_unused_page
  buf.writeUInt32LE(5, 16)
  buf.writeUInt32LE(maxSeq + 2, 20)   // header sequence > all data pages
  // table pointers at 0x1c
  LAYOUTS.forEach((L, i) => {
    const o = 0x1c + i * 16
    const ov = overflow.get(L.type)
    buf.writeUInt32LE(L.type, o)
    buf.writeUInt32LE((ov ? ov.ec : L.emptyCand) >>> 0, o + 4)
    buf.writeUInt32LE(L.header, o + 8)
    buf.writeUInt32LE((ov ? ov.last : L.last) >>> 0, o + 12)
  })

  const putPage = (idx: number, page: Buffer): void => { page.copy(buf, idx * PAGE) }

  // Table pages.
  for (const L of LAYOUTS) {
    const ov = overflow.get(L.type)
    const d = data.get(L.type)
    const firstData = ov ? ov.pages[0] : (L.data !== 0 && L.last !== L.header ? L.data : null)
    const ec = ov ? ov.ec : L.emptyCand
    const nextForHeader = firstData ?? ec
    putPage(L.header, buildHeaderPage(L.header, L.type, nextForHeader, firstData))

    if (firstData == null) continue

    // History tables: embed reference blobs.
    if (L.type === 0x11) { putPage(L.data, history.p36); continue }
    if (L.type === 0x12) { putPage(L.data, history.p38); continue }
    if (L.type === 0x13) { putPage(L.data, history.p40); continue }

    const pages = ov ? ov.pages : [L.data]
    const chunks = d ? d.chunks : [{ heap: Buffer.alloc(0), offsets: [] }]
    const seq = d ? d.seq : 1
    pages.forEach((pi, i) => {
      const next = i + 1 < pages.length ? pages[i + 1] : ec
      const ch = chunks[i] ?? { heap: Buffer.alloc(0), offsets: [] }
      putPage(pi, ch.offsets.length === 0 ? buildBlankDataPage(pi, L.type, next) : buildDataPage(pi, L.type, next, ch.heap, ch.offsets, seq))
    })
  }

  return buf
}
