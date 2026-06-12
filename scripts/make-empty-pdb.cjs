#!/usr/bin/env node
/**
 * Generate a clean, EMPTY export.pdb template from a real one, for initialising
 * blank USBs. Keeps the generic `colors` table (8 fixed colour labels) and the
 * full 20-table skeleton; every other table is reduced to a single empty page,
 * so the template carries NO personal data (safe to bundle).
 *
 * Usage: node scripts/make-empty-pdb.cjs <real-export.pdb> <out-empty.pdb>
 */
const fs = require('fs')
const KS = require('kaitai-struct/KaitaiStream')
const RekordboxPdb = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxPdb.cjs')

const PAGE = 4096, HEADER = 0x28, GROUP_STRIDE = 0x24
// Empty ONLY the tables that hold personal library data. Everything else
// (colors=6, columns=16 browse definitions, and the structural unknown tables)
// is kept verbatim so a CDJ can still build its browse menu — without the
// columns table the players reject the database and fall back to disk browsing.
const EMPTY_TYPES = new Set([
  0, // tracks
  1, // genres
  2, // artists
  3, // albums
  4, // labels
  5, // keys
  7, // playlist_tree
  8, // playlist_entries
  11, // history_playlists
  12, // history_entries
  13, // artwork
  19 // history
])
const KEEP_VERBATIM = { has: (type) => !EMPTY_TYPES.has(type) }

// An empty table in a real pdb is a single NON-DATA "index" page (flags 0x64,
// 0 rows) — every table starts with one, and the players require it. (We used
// to emit a 0x24 DATA page here, which a CDJ-2000NXS2 rejects → "NO DISK".)
function emptyPage(pageIndex, type, nextPage) {
  const p = Buffer.alloc(PAGE)
  p.writeUInt32LE(0, 0); p.writeUInt32LE(pageIndex >>> 0, 4); p.writeUInt32LE(type >>> 0, 8)
  p.writeUInt32LE(nextPage >>> 0, 12); p.writeUInt32LE(0, 16); p.writeUInt32LE(0, 20)
  p.writeUIntLE(0, 24, 3)        // num_row_offsets | num_rows = 0
  p.writeUInt8(0x64, 27)          // NON-DATA index page (bit 0x40 set), 0 rows
  const cap = PAGE - HEADER - GROUP_STRIDE
  p.writeUInt16LE(cap & 0xffff, 28) // free_size
  p.writeUInt16LE(0, 30)            // used_size
  return p
}

function main() {
  const [src, out] = process.argv.slice(2)
  if (!src || !out) { console.error('usage: make-empty-pdb.cjs <src> <out>'); process.exit(1) }
  const buf = fs.readFileSync(src)
  const lenPage = buf.readUInt32LE(4)
  const numTables = buf.readUInt32LE(8)
  if (lenPage !== PAGE) throw new Error('only 4096-byte pages supported')

  const TBL = 28, TSZ = 16
  const tables = []
  for (let i = 0; i < numTables; i++) {
    const o = TBL + i * TSZ
    tables.push({ type: buf.readUInt32LE(o), emptyCand: buf.readUInt32LE(o + 4), first: buf.readUInt32LE(o + 8), last: buf.readUInt32LE(o + 12) })
  }

  // Walk a table's page chain, returning the source page indices in order.
  const chain = (t) => {
    const out = []
    let idx = t.first, guard = 0
    while (guard++ < 5000) {
      out.push(idx)
      if (idx === t.last) break
      const next = buf.readUInt32LE(idx * PAGE + 12)
      if (next >>> 0 === 0xffffffff || next * PAGE >= buf.length) break
      idx = next
    }
    return out
  }

  const newPages = [] // Buffer[], page index = position+1 (page 0 = header)
  let nextIdx = 1
  const newPtr = []
  for (const t of tables) {
    if (KEEP_VERBATIM.has(t.type)) {
      const src = chain(t)
      const firstNew = nextIdx
      const idxs = src.map(() => nextIdx++)
      src.forEach((srcIdx, k) => {
        const page = Buffer.from(buf.subarray(srcIdx * PAGE, srcIdx * PAGE + PAGE))
        page.writeUInt32LE(idxs[k], 4) // page_index
        page.writeUInt32LE(k < idxs.length - 1 ? idxs[k + 1] : 0xffffffff, 12) // next_page
        newPages.push(page)
      })
      newPtr.push({ first: firstNew, last: idxs[idxs.length - 1] })
    } else {
      const i = nextIdx++
      newPages.push(emptyPage(i, t.type, 0xffffffff))
      newPtr.push({ first: i, last: i })
    }
  }

  // Header page.
  const head = Buffer.alloc(PAGE)
  head.writeUInt32LE(0, 0)
  head.writeUInt32LE(PAGE, 4)
  head.writeUInt32LE(numTables, 8)
  head.writeUInt32LE(nextIdx, 12)            // next_unused_page
  head.writeUInt32LE(buf.readUInt32LE(16), 16) // unknown field (real pdbs carry 5; copy it)
  head.writeUInt32LE(buf.readUInt32LE(20), 20) // sequence (copy)
  // gap [24..28) = 0
  tables.forEach((t, i) => {
    const o = TBL + i * TSZ
    head.writeUInt32LE(t.type, o)
    // empty_candidate = the page Rekordbox would allocate next for this table.
    // Real pdbs point it just past the table's last page; mirror that.
    head.writeUInt32LE((newPtr[i].last + 1) >>> 0, o + 4)
    head.writeUInt32LE(newPtr[i].first, o + 8)
    head.writeUInt32LE(newPtr[i].last, o + 12)
  })

  fs.writeFileSync(out, Buffer.concat([head, ...newPages]))
  console.log(`wrote ${out}: ${(1 + newPages.length)} pages (${(1 + newPages.length) * PAGE} bytes)`)

  // Verify: parses + 0 tracks/playlists.
  const pdb = new RekordboxPdb(new KS(fs.readFileSync(out)), null, null, false)
  function count(type) {
    const t = pdb.tables.find((x) => x.type === type); if (!t) return 0
    let ref = t.firstPage, g = 0, rows = 0
    while (ref && g++ < 5000) { let p; try { p = ref.body } catch { break } if (p.type !== type) break; if (p.isDataPage) for (const rg of p.rowGroups) for (const r of rg.rows) { let pr = false; try { pr = r.present } catch {} if (pr) rows++ } if (p.pageIndex === t.lastPage.index) break; ref = p.nextPage }
    return rows
  }
  console.log(`verify: tracks=${count(0)} playlists=${count(7)} colors=${count(6)} (expect 0/0/8)`)
}
main()
