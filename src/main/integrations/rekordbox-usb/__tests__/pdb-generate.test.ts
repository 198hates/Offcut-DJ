import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addArtistToExportPdb,
  addTrackToExportPdb,
  addPlaylistToExportPdb,
} from '../writer'

const TEMPLATE = join(__dirname, '../templates/empty-export.pdb')
const PAGE = 4096

function buildExport(): Buffer {
  let buf: Buffer = readFileSync(TEMPLATE) as Buffer
  buf = addArtistToExportPdb(buf, 1, 'Test Artist One')
  buf = addArtistToExportPdb(buf, 2, 'Test Artist Two')
  buf = addTrackToExportPdb(buf, {
    id: 1, title: 'First Track',
    filePath: '/Contents/Offcut/00000001_first.mp3', filename: '00000001_first.mp3',
    analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT',
    bpm: 128, durationSec: 320, artistId: 1, bitrate: 320, fileSize: 8000000,
  })
  buf = addTrackToExportPdb(buf, {
    id: 2, title: 'Second Track',
    filePath: '/Contents/Offcut/00000002_second.mp3', filename: '00000002_second.mp3',
    analyzePath: '/PIONEER/USBANLZ/OFCT/00000002/ANLZ0000.DAT',
    bpm: 124, durationSec: 300, artistId: 2, bitrate: 320, fileSize: 7000000,
  })
  return addPlaylistToExportPdb(buf, {
    name: 'Offcut Test Set', trackIds: [1, 2], newPlaylistId: 1, sortOrder: 1,
  })
}

// Structural invariants a real CDJ enforces (validated against a known-good
// Rekordbox stick: a CDJ-3000 rejected our export with "Database not found!"
// because our written data pages had sequence 0 — which never occurs in a real
// export.pdb).
describe('export.pdb page-level validity', () => {
  it('no data page (rows > 0) is left at sequence 0', () => {
    const b = buildExport()
    // Emit the artifact for offline structural diffing against a real stick.
    if (process.env.PDB_DUMP) writeFileSync(process.env.PDB_DUMP, b)
    const offenders: number[] = []
    for (let i = 1; i < b.length / PAGE; i++) {
      const o = i * PAGE
      const seq = b.readUInt32LE(o + 16)
      const nRows = (b.readUIntLE(o + 24, 3) >> 13) & 0x7ff
      const isDataPage = (b.readUInt8(o + 27) & 0x40) === 0
      if (isDataPage && nRows > 0 && seq === 0) offenders.push(i)
    }
    expect(offenders).toEqual([])
  })

  it('every page sequence is ≤ the header sequence', () => {
    const b = buildExport()
    const headerSeq = b.readUInt32LE(20)
    for (let i = 1; i < b.length / PAGE; i++) {
      expect(b.readUInt32LE(i * PAGE + 16)).toBeLessThanOrEqual(headerSeq)
    }
  })

  it('next_unused_page equals the page count', () => {
    const b = buildExport()
    expect(b.readUInt32LE(12)).toBe(b.length / PAGE)
  })

  it("each extended table's empty_candidate points past its last page", () => {
    const b = buildExport()
    const numTables = b.readUInt32LE(8)
    for (let i = 0; i < numTables; i++) {
      const off = 28 + i * 16
      const emptyCand = b.readUInt32LE(off + 4)
      const last = b.readUInt32LE(off + 12)
      expect(emptyCand).toBeGreaterThan(last)
    }
  })
})
