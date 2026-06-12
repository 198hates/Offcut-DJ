#!/usr/bin/env node
/**
 * M1 validation: append a playlist to an export.pdb on a COPY, then re-read it
 * with the M0 parser to confirm the new playlist + its entries round-trip.
 *
 * Strategy: APPEND-ONLY. We add new pages at the end of the file for the new
 * playlist (a playlist_tree row + playlist_entries rows) and patch only the
 * header pointers of existing pages (next_page) and the table headers
 * (last_page / next_unused_page). Existing page heaps are never rewritten, so we
 * can't corrupt existing data.
 *
 * Usage: node scripts/test-write-playlist.cjs /path/to/export.pdb [out.pdb]
 */
const fs = require('fs')
const KS = require('kaitai-struct/KaitaiStream')
const RekordboxPdb = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxPdb.cjs')

const PAGE = 4096
const HEADER = 0x28 // 40 — page header size / heap start
const GROUP_STRIDE = 0x24 // 36 — bytes per 16-row group at page end
const ENTRY_SIZE = 12
const MAX_ENTRIES_PER_PAGE = 256 // clean 16-group boundary, well under the ~283 ceiling

// ── DeviceSQL short ASCII string ──────────────────────────────────────────
function deviceSqlString(s) {
  // ASCII only for names we write. header byte = 2*len + 3 (odd → short ascii).
  const ascii = Buffer.from(s, 'ascii')
  if (ascii.length > 126) throw new Error('playlist name too long')
  return Buffer.concat([Buffer.from([ascii.length * 2 + 3]), ascii])
}

// ── Row builders ───────────────────────────────────────────────────────────
function playlistTreeRow({ parentId, sortOrder, id, isFolder, name }) {
  const head = Buffer.alloc(20)
  head.writeUInt32LE(parentId >>> 0, 0)
  head.writeUInt32LE(0, 4) // unknown
  head.writeUInt32LE(sortOrder >>> 0, 8)
  head.writeUInt32LE(id >>> 0, 12)
  head.writeUInt32LE(isFolder ? 1 : 0, 16)
  return Buffer.concat([head, deviceSqlString(name)])
}

function playlistEntryRow({ entryIndex, trackId, playlistId }) {
  const b = Buffer.alloc(ENTRY_SIZE)
  b.writeUInt32LE(entryIndex >>> 0, 0)
  b.writeUInt32LE(trackId >>> 0, 4)
  b.writeUInt32LE(playlistId >>> 0, 8)
  return b
}

// ── Page builder (data page) ────────────────────────────────────────────────
function buildPage({ pageIndex, type, nextPage, rows }) {
  const page = Buffer.alloc(PAGE)
  page.writeUInt32LE(0, 0) // gap
  page.writeUInt32LE(pageIndex >>> 0, 4)
  page.writeUInt32LE(type >>> 0, 8)
  page.writeUInt32LE(nextPage >>> 0, 12)
  page.writeUInt32LE(0, 16) // sequence
  page.writeUInt32LE(0, 20)

  const n = rows.length
  // bit-packed: num_row_offsets (13 bits) | num_rows (11 bits) << 13, 3 bytes LE
  const packed = (n & 0x1fff) | ((n & 0x7ff) << 13)
  page.writeUIntLE(packed >>> 0, 24, 3)
  page.writeUInt8(0x24, 27) // page_flags → data page (bit 0x40 clear)

  // Heap (row data) grows up from HEADER.
  const offsets = []
  let heap = 0
  for (const r of rows) {
    offsets.push(heap)
    r.copy(page, HEADER + heap)
    heap += r.length
  }
  const usedSize = heap

  // Row index grows down from the end, in groups of 16.
  const numGroups = Math.max(1, Math.ceil(n / 16))
  for (let g = 0; g < numGroups; g++) {
    const base = PAGE - g * GROUP_STRIDE
    let present = 0
    for (let r = 0; r < 16; r++) {
      const gi = g * 16 + r
      if (gi < n) present |= 1 << r
    }
    page.writeUInt16LE(present, base - 4) // row_present_flags
    for (let r = 0; r < 16; r++) {
      const gi = g * 16 + r
      page.writeUInt16LE(gi < n ? offsets[gi] & 0xffff : 0, base - 6 - 2 * r)
    }
    // base-2..base-1 (transaction_row_flags) left 0
  }

  const capacity = PAGE - HEADER - numGroups * GROUP_STRIDE
  page.writeUInt16LE(Math.max(0, capacity - usedSize) & 0xffff, 28) // free_size
  page.writeUInt16LE(usedSize & 0xffff, 30) // used_size
  return page
}

// ── Header / table helpers (raw buffer) ──────────────────────────────────────
const TABLES_OFFSET = 28
const TABLE_SIZE = 16
function findTable(buf, numTables, type) {
  for (let i = 0; i < numTables; i++) {
    const off = TABLES_OFFSET + i * TABLE_SIZE
    if (buf.readUInt32LE(off) === type) return off
  }
  return -1
}
const tableFirstPage = (buf, off) => buf.readUInt32LE(off + 8)
const tableLastPage = (buf, off) => buf.readUInt32LE(off + 12)
const setTableLastPage = (buf, off, v) => buf.writeUInt32LE(v >>> 0, off + 12)
const pageNextOffset = (pageIndex) => pageIndex * PAGE + 12
const setPageNext = (buf, pageIndex, v) => buf.writeUInt32LE(v >>> 0, pageNextOffset(pageIndex))

/**
 * Append a playlist (name + ordered trackIds) to an export.pdb buffer.
 * Returns a NEW buffer; the input is not mutated.
 */
function addPlaylist(buf0, { name, trackIds, newPlaylistId, sortOrder }) {
  const buf = Buffer.from(buf0) // copy
  const lenPage = buf.readUInt32LE(4)
  if (lenPage !== PAGE) throw new Error(`unexpected page size ${lenPage}`)
  const numTables = buf.readUInt32LE(8)

  const treeOff = findTable(buf, numTables, RekordboxPdb.PageType.PLAYLIST_TREE)
  const entOff = findTable(buf, numTables, RekordboxPdb.PageType.PLAYLIST_ENTRIES)
  if (treeOff < 0 || entOff < 0) throw new Error('playlist tables not found')

  let nextNewIndex = buf.length / PAGE // append at end of file
  const newPages = []

  // 1) playlist_entries pages (chunked).
  const entriesLastOld = tableLastPage(buf, entOff)
  let prevEntriesPage = entriesLastOld
  const entryPageIndices = []
  for (let i = 0; i < trackIds.length; i += MAX_ENTRIES_PER_PAGE) {
    const chunk = trackIds.slice(i, i + MAX_ENTRIES_PER_PAGE)
    const idx = nextNewIndex++
    entryPageIndices.push(idx)
    const rows = chunk.map((tid, j) =>
      playlistEntryRow({ entryIndex: i + j + 1, trackId: tid, playlistId: newPlaylistId })
    )
    newPages.push({ index: idx, type: RekordboxPdb.PageType.PLAYLIST_ENTRIES, rows, _link: prevEntriesPage })
    prevEntriesPage = idx
  }

  // 2) playlist_tree page (one row).
  const treeLastOld = tableLastPage(buf, treeOff)
  const treeIdx = nextNewIndex++
  newPages.push({
    index: treeIdx,
    type: RekordboxPdb.PageType.PLAYLIST_TREE,
    rows: [playlistTreeRow({ parentId: 0, sortOrder, id: newPlaylistId, isFolder: false, name })],
    _link: treeLastOld
  })

  // Grow the file with the new pages, then patch links.
  const tail = Buffer.alloc(newPages.length * PAGE)
  let out = Buffer.concat([buf, tail])

  for (const p of newPages) {
    const page = buildPage({ pageIndex: p.index, type: p.type, nextPage: 0xffffffff, rows: p.rows })
    page.copy(out, p.index * PAGE)
  }
  // Chain entries pages: old-last → new1 → new2 … ; tree old-last → new tree.
  if (entryPageIndices.length) {
    setPageNext(out, entriesLastOld, entryPageIndices[0])
    for (let i = 0; i < entryPageIndices.length - 1; i++) setPageNext(out, entryPageIndices[i], entryPageIndices[i + 1])
    setTableLastPage(out, entOff, entryPageIndices[entryPageIndices.length - 1])
  }
  setPageNext(out, treeLastOld, treeIdx)
  setTableLastPage(out, treeOff, treeIdx)

  // next_unused_page → past everything.
  out.writeUInt32LE(out.length / PAGE, 12)
  return out
}

// ── Run: read, add a test playlist, write a copy, re-read to verify ──────────
function readSummary(buf) {
  const pdb = new RekordboxPdb(new KS(buf), null, null, false)
  function* rows(type) {
    const t = pdb.tables.find((x) => x.type === type)
    if (!t) return
    let ref = t.firstPage, guard = 0
    while (ref && guard++ < 500000) {
      let pg; try { pg = ref.body } catch { break }
      if (pg && pg.type !== type) break
      if (pg && pg.isDataPage) for (const rg of pg.rowGroups) for (const r of rg.rows) {
        let pres = false; try { pres = r.present } catch {}
        if (pres) { try { if (r.body) yield r.body } catch {} }
      }
      if (pg && pg.pageIndex === t.lastPage.index) break
      ref = pg ? pg.nextPage : null
    }
  }
  const str = (s) => { try { return s.body.text } catch { return '' } }
  const tracks = []
  for (const t of rows(RekordboxPdb.PageType.TRACKS)) tracks.push(t.id)
  const pls = []
  for (const p of rows(RekordboxPdb.PageType.PLAYLIST_TREE)) pls.push({ id: p.id, name: str(p.name), isFolder: p.isFolder })
  const entries = new Map()
  for (const e of rows(RekordboxPdb.PageType.PLAYLIST_ENTRIES)) {
    if (!entries.has(e.playlistId)) entries.set(e.playlistId, [])
    entries.get(e.playlistId).push({ idx: e.entryIndex, trackId: e.trackId })
  }
  return { trackIds: tracks, playlists: pls, entries }
}

function main() {
  const inPath = process.argv[2]
  const outPath = process.argv[3] || '/tmp/njc1-analysis/export-modified.pdb'
  if (!inPath) { console.error('pass an export.pdb path'); process.exit(1) }

  const before = readSummary(fs.readFileSync(inPath))
  const maxId = before.playlists.reduce((m, p) => Math.max(m, p.id), 0)
  const newId = maxId + 1
  const sampleTracks = before.trackIds.slice(0, 12)
  console.log(`before: ${before.trackIds.length} tracks, ${before.playlists.length} playlists. new id=${newId}`)
  console.log('writing playlist "OFFCUT TEST" with', sampleTracks.length, 'entries')

  const out = addPlaylist(fs.readFileSync(inPath), {
    name: 'OFFCUT TEST',
    trackIds: sampleTracks,
    newPlaylistId: newId,
    sortOrder: before.playlists.length + 1
  })
  fs.writeFileSync(outPath, out)
  console.log('wrote', outPath, `(${out.length} bytes, +${(out.length - before.trackIds.length * 0) - fs.readFileSync(inPath).length} bytes)`)

  // Re-read and verify.
  const after = readSummary(out)
  const found = after.playlists.find((p) => p.name === 'OFFCUT TEST')
  console.log(`\nafter: ${after.trackIds.length} tracks, ${after.playlists.length} playlists`)
  if (!found) { console.error('❌ new playlist NOT found after re-read'); process.exit(1) }
  const got = (after.entries.get(found.id) || []).sort((a, b) => a.idx - b.idx)
  const ok =
    got.length === sampleTracks.length &&
    got.every((g, i) => g.trackId === sampleTracks[i] && g.idx === i + 1)
  console.log(`✅ found "OFFCUT TEST" (id ${found.id}) with ${got.length} entries`)
  console.log('   entries match input order:', ok ? 'YES' : 'NO')
  // Existing playlists intact?
  const beforeNames = before.playlists.map((p) => p.name).sort().join('|')
  const afterNames = after.playlists.filter((p) => p.name !== 'OFFCUT TEST').map((p) => p.name).sort().join('|')
  console.log('   existing playlists intact:', beforeNames === afterNames ? 'YES' : 'NO')
  console.log('   track count unchanged:', before.trackIds.length === after.trackIds.length ? 'YES' : 'NO')
  if (!ok || beforeNames !== afterNames) process.exit(1)
}

main()
