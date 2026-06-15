import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildExportPdb, type PdbTrack, type PdbPlaylist } from '../pdb-builder'

const T = join(__dirname, '../templates')
const history = {
  p36: readFileSync(join(T, 'history-p36.bin')) as Buffer,
  p38: readFileSync(join(T, 'history-p38.bin')) as Buffer,
  p40: readFileSync(join(T, 'history-p40.bin')) as Buffer
}

function track(id: number, over: Partial<PdbTrack> = {}): PdbTrack {
  return {
    id, title: `Track ${id}`, artist: `Artist ${id}`, album: '', genre: '', label: '',
    remixer: '', key: '8B', sampleRate: 44100, fileSize: 8000000, bitrate: 320,
    trackNumber: 0, tempo: 12800, discNumber: 0, year: 2020, durationSecs: 300,
    fileName: `${id}.mp3`, fileExt: 'mp3', usbPath: `/Contents/Offcut/${id}.mp3`,
    analyzePath: `/PIONEER/USBANLZ/OFCT/0000000${id}/ANLZ0000.DAT`, comment: '',
    ...over
  }
}

describe('buildExportPdb — CDJ-format export', () => {
  it('builds a valid 2-track export and dumps it', () => {
    const tracks = [track(1), track(2)]
    const playlists: PdbPlaylist[] = [{ id: 1, name: 'Test Set', trackIds: [1, 2] }]
    const buf = buildExportPdb(tracks, playlists, history, '2026-06-13')
    if (process.env.PDB_DUMP) writeFileSync(process.env.PDB_DUMP, buf)
    expect(buf.length % 4096).toBe(0)
    expect(buf.readUInt32LE(4)).toBe(4096) // len_page
    expect(buf.readUInt32LE(8)).toBe(20)   // num_tables
  })

  it('header pages carry the fill pattern (the CDJ-3000 gatekeeper)', () => {
    const buf = buildExportPdb([track(1), track(2)], [{ id: 1, name: 'P', trackIds: [1, 2] }], history, '2026-06-13')
    const P = 4096
    // tracks header page = 1
    expect(buf.readUInt16LE(1 * P + 0x26)).toBe(1)          // unknown7
    expect(buf.readUInt32LE(1 * P + 0x38)).toBe(0x1fff0001) // sentinel
    expect(buf.readUInt32LE(1 * P + 0x3c)).toBe(0x10)       // tracks marker
    expect(buf.readUInt32LE(1 * P + 0x40)).toBe(0x1ffffff8) // fill pattern
    // history header page = 39
    expect(buf.readUInt32LE(39 * P + 0x3c)).toBe(0x140)
  })

  it('no data page is left at sequence 0; last pages chain to empty_candidate (not 0xffffffff)', () => {
    const buf = buildExportPdb([track(1), track(2)], [{ id: 1, name: 'P', trackIds: [1, 2] }], history, '2026-06-13')
    const P = 4096, n = buf.readUInt32LE(8)
    for (let i = 1; i < buf.length / P; i++) {
      const o = i * P
      const nrows = (buf.readUIntLE(o + 24, 3) >> 13) & 0x7ff
      if ((buf.readUInt8(o + 27) & 0x40) === 0 && nrows > 0) expect(buf.readUInt32LE(o + 16)).not.toBe(0)
    }
    // every table's last page next_page == its empty_candidate, never 0xffffffff
    for (let i = 0; i < n; i++) {
      const ptr = 0x1c + i * 16
      const last = buf.readUInt32LE(ptr + 12)
      const ec = buf.readUInt32LE(ptr + 4)
      const np = buf.readUInt32LE(last * P + 12)
      expect(np).not.toBe(0xffffffff)
      expect(np).toBe(ec)
    }
  })

  it('embeds the reference history blobs', () => {
    const buf = buildExportPdb([track(1)], [{ id: 1, name: 'P', trackIds: [1] }], history, '2026-06-13')
    const P = 4096
    expect(buf.subarray(40 * P, 41 * P).equals(history.p40)).toBe(true) // history data page
  })

  it('handles many tracks (overflow pages)', () => {
    const tracks = Array.from({ length: 40 }, (_, i) => track(i + 1))
    const playlists: PdbPlaylist[] = [{ id: 1, name: 'Big Set', trackIds: tracks.map((t) => t.id) }]
    const buf = buildExportPdb(tracks, playlists, history, '2026-06-13')
    expect(buf.length / 4096).toBeGreaterThan(41) // overflow allocated
  })

  // Regression: a missing u32 in the album row left ofs_name pointing past the
  // fixed part, so the name was read from garbage and the Albums page parsed as
  // corrupt — which crashed the CDJ on USB load.
  it('album rows place the name at ofs_name (CDJ-crash regression)', () => {
    const buf = buildExportPdb(
      [track(1, { album: 'My Album' })],
      [{ id: 1, name: 'P', trackIds: [1] }],
      history,
      '2026-06-13'
    )
    const rowStart = 8 * 4096 + 0x28 // first row in the Albums data page (page 8)
    expect(buf.readUInt8(rowStart + 21)).toBe(0x16) // ofs_name → name at offset 22
    const nameOff = rowStart + 0x16
    const hdr = buf.readUInt8(nameOff) // DeviceSQL short ASCII: ((len+1)<<1)|1
    const len = (hdr >> 1) - 1
    expect(buf.toString('ascii', nameOff + 1, nameOff + 1 + len)).toBe('My Album')
  })

  it('writes artwork rows and links tracks via artwork_id', () => {
    const path = '/PIONEER/Artwork/00001/a1.jpg'
    const buf = buildExportPdb(
      [track(1, { artworkId: 1 })],
      [{ id: 1, name: 'P', trackIds: [1] }],
      history,
      '2026-06-13',
      [{ id: 1, path }]
    )
    // artwork data page = 28 (LAYOUTS); row = u4 id + DeviceSQL path inline.
    const rowStart = 28 * 4096 + 0x28
    expect(buf.readUInt32LE(rowStart)).toBe(1) // artwork id
    const hdr = buf.readUInt8(rowStart + 4) // DeviceSQL short ASCII header
    const len = (hdr >> 1) - 1
    expect(buf.toString('ascii', rowStart + 5, rowStart + 5 + len)).toBe(path)
    // track row carries the artwork_id (offset 0x1c within the 0x5e fixed header).
    const trackRow = 2 * 4096 + 0x28
    expect(buf.readUInt32LE(trackRow + 0x1c)).toBe(1)
  })
})
