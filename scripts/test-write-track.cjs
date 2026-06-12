#!/usr/bin/env node
/**
 * M2a validation: append a NEW track_row to an export.pdb on a COPY, then
 * re-read it to confirm the track (title / file_path / analyze_path / tempo /
 * id) round-trips and nothing existing changed.
 *
 * Append-only, same page mechanics as the playlist writer. Lookup rows
 * (artist/album/key/genre) are referenced as 0 (unknown) for this first cut —
 * the track is still playable; names get added in a later step.
 *
 * Usage: node scripts/test-write-track.cjs /path/to/export.pdb
 */
const fs = require('fs')
const KS = require('kaitai-struct/KaitaiStream')
const RekordboxPdb = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxPdb.cjs')

const PAGE = 4096, HEADER = 0x28, GROUP_STRIDE = 0x24

// ── DeviceSQL string: short-ascii / long-ascii / long-utf16le ───────────────
function deviceSqlString(s) {
  s = s || ''
  const isAscii = /^[\x00-\x7F]*$/.test(s)
  if (isAscii && s.length <= 126) {
    return Buffer.concat([Buffer.from([s.length * 2 + 3]), Buffer.from(s, 'ascii')])
  }
  if (isAscii) {
    const body = Buffer.from(s, 'ascii')
    const head = Buffer.alloc(4)
    head.writeUInt8(0x40, 0); head.writeUInt16LE(body.length + 4, 1); head.writeUInt8(0, 3)
    return Buffer.concat([head, body])
  }
  const body = Buffer.from(s, 'utf16le')
  const head = Buffer.alloc(4)
  head.writeUInt8(0x90, 0); head.writeUInt16LE(body.length + 4, 1); head.writeUInt8(0, 3)
  return Buffer.concat([head, body])
}

// ── track_row builder ───────────────────────────────────────────────────────
function trackRow(o) {
  const fixed = Buffer.alloc(94)
  let p = 0
  const u2 = (v) => { fixed.writeUInt16LE(v & 0xffff, p); p += 2 }
  const u4 = (v) => { fixed.writeUInt32LE(v >>> 0, p); p += 4 }
  const u1 = (v) => { fixed.writeUInt8(v & 0xff, p); p += 1 }
  u2(0x24)              // subtype (0x04 ⇒ 16-bit offsets)
  u2(0)                 // index_shift
  u4(0)                 // bitmask
  u4(o.sampleRate || 44100)
  u4(0)                 // composer_id
  u4(o.fileSize || 0)
  u4(0)                 // some id
  u2(19048)             // "always 19048"
  u2(30967)             // "always 30967"
  u4(0)                 // artwork_id
  u4(o.keyId || 0)
  u4(0)                 // original_artist_id
  u4(0)                 // label_id
  u4(0)                 // remixer_id
  u4(o.bitrate || 0)
  u4(o.trackNumber || 0)
  u4(Math.round((o.bpm || 0) * 100)) // tempo
  u4(o.genreId || 0)
  u4(o.albumId || 0)
  u4(o.artistId || 0)
  u4(o.id)              // track id
  u2(0)                 // disc_number
  u2(0)                 // play_count
  u2(o.year || 0)
  u2(16)                // sample_depth
  u2(o.duration || 0)
  u2(41)                // "always 41"
  u1(0)                 // color_id
  u1(o.rating || 0)
  u2(1)                 // "always 1"
  u2(3)                 // "alternating 2/3"

  // 21 strings; only a few are meaningful, rest empty.
  const strings = new Array(21).fill('')
  strings[14] = o.analyzePath || ''
  strings[17] = o.title || ''
  strings[19] = o.filename || ''
  strings[20] = o.filePath || ''
  // Rekordbox stores dates as strings; harmless to leave empty.

  const offsetsBuf = Buffer.alloc(21 * 2)
  const bodies = []
  let cursor = 94 + 21 * 2 // strings begin after fixed + offset table
  for (let i = 0; i < 21; i++) {
    offsetsBuf.writeUInt16LE(cursor, i * 2)
    const b = deviceSqlString(strings[i])
    bodies.push(b)
    cursor += b.length
  }
  return Buffer.concat([fixed, offsetsBuf, ...bodies])
}

// ── page builder (same as playlist writer) ──────────────────────────────────
function buildPage({ pageIndex, type, nextPage, rows }) {
  const page = Buffer.alloc(PAGE)
  page.writeUInt32LE(0, 0); page.writeUInt32LE(pageIndex >>> 0, 4)
  page.writeUInt32LE(type >>> 0, 8); page.writeUInt32LE(nextPage >>> 0, 12)
  page.writeUInt32LE(0, 16); page.writeUInt32LE(0, 20)
  const n = rows.length
  page.writeUIntLE(((n & 0x1fff) | ((n & 0x7ff) << 13)) >>> 0, 24, 3)
  page.writeUInt8(0x24, 27)
  const offs = []; let heap = 0
  for (const r of rows) { offs.push(heap); r.copy(page, HEADER + heap); heap += r.length }
  const numGroups = Math.max(1, Math.ceil(n / 16))
  for (let g = 0; g < numGroups; g++) {
    const base = PAGE - g * GROUP_STRIDE
    let present = 0
    for (let r = 0; r < 16; r++) if (g * 16 + r < n) present |= 1 << r
    page.writeUInt16LE(present, base - 4)
    for (let r = 0; r < 16; r++) { const gi = g * 16 + r; page.writeUInt16LE(gi < n ? offs[gi] & 0xffff : 0, base - 6 - 2 * r) }
  }
  const cap = PAGE - HEADER - numGroups * GROUP_STRIDE
  page.writeUInt16LE(Math.max(0, cap - heap) & 0xffff, 28)
  page.writeUInt16LE(heap & 0xffff, 30)
  return page
}

const TBL = 28, TSZ = 16
const findTable = (b, n, t) => { for (let i = 0; i < n; i++) if (b.readUInt32LE(TBL + i * TSZ) === t) return TBL + i * TSZ; return -1 }
const lastPage = (b, o) => b.readUInt32LE(o + 12)
const setLast = (b, o, v) => b.writeUInt32LE(v >>> 0, o + 12)
const setNext = (b, idx, v) => b.writeUInt32LE(v >>> 0, idx * PAGE + 12)

function addTrack(buf0, opts) {
  const buf = Buffer.from(buf0)
  const numTables = buf.readUInt32LE(8)
  const tOff = findTable(buf, numTables, RekordboxPdb.PageType.TRACKS)
  if (tOff < 0) throw new Error('tracks table not found')
  const newIdx = buf.length / PAGE
  const row = trackRow(opts)
  if (HEADER + row.length + GROUP_STRIDE > PAGE) throw new Error('track row too large for a page')
  const page = buildPage({ pageIndex: newIdx, type: RekordboxPdb.PageType.TRACKS, nextPage: 0xffffffff, rows: [row] })
  const out = Buffer.concat([buf, page])
  const oldLast = lastPage(out, tOff)
  setNext(out, oldLast, newIdx)
  setLast(out, tOff, newIdx)
  out.writeUInt32LE(out.length / PAGE, 12)
  return out
}

// ── round-trip ───────────────────────────────────────────────────────────────
function read(buf) {
  const pdb = new RekordboxPdb(new KS(buf), null, null, false)
  function* rows(type) {
    const t = pdb.tables.find((x) => x.type === type); if (!t) return
    let ref = t.firstPage, g = 0
    while (ref && g++ < 500000) {
      let pg; try { pg = ref.body } catch { break }
      if (pg && pg.type !== type) break
      if (pg && pg.isDataPage) for (const rg of pg.rowGroups) for (const r of rg.rows) { let pr = false; try { pr = r.present } catch {} if (pr) { try { if (r.body) yield r.body } catch {} } }
      if (pg && pg.pageIndex === t.lastPage.index) break
      ref = pg ? pg.nextPage : null
    }
  }
  const s = (x) => { try { return x.body.text } catch { return '' } }
  const tracks = []
  for (const t of rows(RekordboxPdb.PageType.TRACKS)) tracks.push({ id: t.id, title: s(t.title), filePath: s(t.filePath), analyzePath: s(t.analyzePath), tempo: t.tempo })
  return tracks
}

module.exports = { addTrack, trackRow, deviceSqlString, readTracks: read }
if (require.main !== module) return

const inPath = process.argv[2]
if (!inPath) { console.error('pass export.pdb'); process.exit(1) }
const before = read(fs.readFileSync(inPath))
const maxId = before.reduce((m, t) => Math.max(m, t.id), 0)
const newId = maxId + 1
console.log(`before: ${before.length} tracks, max id ${maxId}`)

const out = addTrack(fs.readFileSync(inPath), {
  id: newId, title: 'Offcut New Track Test', bpm: 124.0, duration: 215,
  filePath: '/Contents/Offcut/offcut-test.mp3', filename: 'offcut-test.mp3',
  analyzePath: '/PIONEER/USBANLZ/POFF/00000001/ANLZ0000.DAT', bitrate: 320, fileSize: 8600000
})
fs.writeFileSync('/tmp/njc1-analysis/export-newtrack.pdb', out)

const after = read(out)
const found = after.find((t) => t.id === newId)
console.log(`after: ${after.length} tracks`)
if (!found) { console.error('❌ new track not found'); process.exit(1) }
console.log('✅ new track round-tripped:')
console.log('   id', found.id, '| title:', JSON.stringify(found.title))
console.log('   tempo', found.tempo, '(expect 12400) | bpm', found.tempo / 100)
console.log('   file_path:', found.filePath)
console.log('   analyze_path:', found.analyzePath)
const intact = before.every((b) => { const a = after.find((x) => x.id === b.id); return a && a.title === b.title && a.filePath === b.filePath })
console.log('   existing tracks intact:', intact ? 'YES' : 'NO')
const ok = found.title === 'Offcut New Track Test' && found.tempo === 12400 && found.filePath === '/Contents/Offcut/offcut-test.mp3' && found.analyzePath === '/PIONEER/USBANLZ/POFF/00000001/ANLZ0000.DAT' && intact && after.length === before.length + 1
console.log(ok ? '\n✅ ALL CHECKS PASS' : '\n❌ CHECKS FAILED')
process.exit(ok ? 0 : 1)
