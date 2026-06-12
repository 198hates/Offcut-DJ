import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseExportPdb } from '../reader'
import {
  addTrackToExportPdb,
  addArtistToExportPdb,
  addPlaylistToExportPdb,
  addEntriesToExportPdb,
} from '../writer'
import { buildDatAnlz, beatsFromBpm, beatsFromMarkers } from '../anlz'

const TEMPLATE = join(__dirname, '../templates/empty-export.pdb')

// ── PDB round-trip ────────────────────────────────────────────────────────────

describe('addTrackToExportPdb', () => {
  it('adds a track that round-trips through parseExportPdb', () => {
    const buf = readFileSync(TEMPLATE)
    const { tracks: before } = parseExportPdb(buf)
    const id = before.reduce((m, t) => Math.max(m, t.id), 0) + 1
    const out = addTrackToExportPdb(buf, {
      id,
      title: 'Test Track',
      filePath: '/Contents/Offcut/00000001_test.mp3',
      filename: '00000001_test.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT',
      bpm: 128.5,
      durationSec: 300,
    })
    const { tracks: after } = parseExportPdb(out)
    const found = after.find((t) => t.id === id)
    expect(found).toBeTruthy()
    expect(found!.title).toBe('Test Track')
    expect(found!.bpm).toBeCloseTo(128.5, 1)
    expect(found!.filePath).toBe('/Contents/Offcut/00000001_test.mp3')
    expect(found!.analyzePath).toBe('/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT')
    expect(after.length).toBe(before.length + 1)
  })

  it('existing tracks are intact after adding a new one', () => {
    const buf = readFileSync(TEMPLATE)
    const b2 = addTrackToExportPdb(buf, {
      id: 1, title: 'Alpha', filePath: '/Contents/a.mp3', filename: 'a.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT', bpm: 120, durationSec: 200,
    })
    const b3 = addTrackToExportPdb(b2, {
      id: 2, title: 'Beta', filePath: '/Contents/b.mp3', filename: 'b.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000002/ANLZ0000.DAT', bpm: 130, durationSec: 210,
    })
    const { tracks } = parseExportPdb(b3)
    expect(tracks.find((t) => t.id === 1)?.title).toBe('Alpha')
    expect(tracks.find((t) => t.id === 2)?.title).toBe('Beta')
  })

  it('handles non-ASCII titles (UTF-16LE encoding)', () => {
    const buf = readFileSync(TEMPLATE)
    const out = addTrackToExportPdb(buf, {
      id: 1, title: 'テスト曲', filePath: '/Contents/j.mp3', filename: 'j.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT', bpm: 130, durationSec: 200,
    })
    const { tracks } = parseExportPdb(out)
    expect(tracks.find((t) => t.id === 1)?.title).toBe('テスト曲')
  })

  // Regression for filename collision fix (phase 7 audit)
  it('two tracks with the same source filename get different device paths', () => {
    const buf = readFileSync(TEMPLATE)
    const b2 = addTrackToExportPdb(buf, {
      id: 1, title: 'Track A',
      filePath: '/Contents/Offcut/00000001_track.mp3',
      filename: '00000001_track.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT',
      bpm: 120, durationSec: 200,
    })
    const b3 = addTrackToExportPdb(b2, {
      id: 2, title: 'Track B',
      filePath: '/Contents/Offcut/00000002_track.mp3',
      filename: '00000002_track.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000002/ANLZ0000.DAT',
      bpm: 120, durationSec: 200,
    })
    const { tracks } = parseExportPdb(b3)
    const a = tracks.find((t) => t.id === 1)!
    const b = tracks.find((t) => t.id === 2)!
    expect(a.filePath).not.toBe(b.filePath)
    expect(a.filePath).toContain('00000001_track.mp3')
    expect(b.filePath).toContain('00000002_track.mp3')
  })
})

describe('addArtistToExportPdb', () => {
  it('adds an artist that round-trips', () => {
    const buf = readFileSync(TEMPLATE)
    const out = addArtistToExportPdb(buf, 42, 'John Coltrane')
    const { artists } = parseExportPdb(out)
    expect(artists.find((a) => a.id === 42)?.name).toBe('John Coltrane')
  })
})

describe('addPlaylistToExportPdb', () => {
  it('adds a playlist with track references', () => {
    const buf = readFileSync(TEMPLATE)
    const b2 = addTrackToExportPdb(buf, {
      id: 1, title: 'T1', filePath: '/Contents/t1.mp3', filename: 't1.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT', bpm: 120, durationSec: 200,
    })
    const b3 = addTrackToExportPdb(b2, {
      id: 2, title: 'T2', filePath: '/Contents/t2.mp3', filename: 't2.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000002/ANLZ0000.DAT', bpm: 125, durationSec: 210,
    })
    const b4 = addPlaylistToExportPdb(b3, {
      name: 'Friday Night',
      trackIds: [1, 2],
      newPlaylistId: 1,
      sortOrder: 1,
    })
    const { playlists } = parseExportPdb(b4)
    const pl = playlists.find((p) => p.name === 'Friday Night')
    expect(pl).toBeTruthy()
    expect(pl!.isFolder).toBe(false)
    expect(pl!.trackIds).toEqual([1, 2])
  })

  it('preserves existing playlists when adding another', () => {
    const buf = readFileSync(TEMPLATE)
    const b2 = addTrackToExportPdb(buf, {
      id: 1, title: 'T', filePath: '/Contents/t.mp3', filename: 't.mp3',
      analyzePath: '/PIONEER/USBANLZ/OFCT/00000001/ANLZ0000.DAT', bpm: 120, durationSec: 200,
    })
    const b3 = addPlaylistToExportPdb(b2, { name: 'Pl 1', trackIds: [1], newPlaylistId: 1, sortOrder: 1 })
    const b4 = addPlaylistToExportPdb(b3, { name: 'Pl 2', trackIds: [1], newPlaylistId: 2, sortOrder: 2 })
    const { playlists } = parseExportPdb(b4)
    expect(playlists.find((p) => p.name === 'Pl 1')).toBeTruthy()
    expect(playlists.find((p) => p.name === 'Pl 2')).toBeTruthy()
  })
})

describe('addEntriesToExportPdb', () => {
  it('appends entries to an existing playlist', () => {
    // tracks 1-3
    let b: Buffer = readFileSync(TEMPLATE) as Buffer
    for (const id of [1, 2, 3]) {
      b = addTrackToExportPdb(b, {
        id, title: `T${id}`, filePath: `/Contents/t${id}.mp3`, filename: `t${id}.mp3`,
        analyzePath: `/PIONEER/USBANLZ/OFCT/${id.toString(16).padStart(8, '0')}/ANLZ0000.DAT`,
        bpm: 120, durationSec: 200,
      })
    }
    // Initial playlist with tracks 1+2
    b = addPlaylistToExportPdb(b, { name: 'Grow', trackIds: [1, 2], newPlaylistId: 1, sortOrder: 1 })
    // Append track 3
    b = addEntriesToExportPdb(b, 1, [3], 2)
    const { playlists } = parseExportPdb(b)
    const pl = playlists.find((p) => p.name === 'Grow')
    expect(pl?.trackIds).toContain(3)
    expect(pl?.trackIds?.length).toBe(3)
  })
})

// ── ANLZ generation ───────────────────────────────────────────────────────────

describe('beatsFromBpm', () => {
  it('generates the right number of beats', () => {
    const beats = beatsFromBpm(120, 60) // 2 beats/s × 60 s = 120 beats
    expect(beats.length).toBe(120)
  })

  it('cycles beat numbers 1-4', () => {
    const beats = beatsFromBpm(120, 10)
    expect(beats[0].beatNumber).toBe(1)
    expect(beats[1].beatNumber).toBe(2)
    expect(beats[3].beatNumber).toBe(4)
    expect(beats[4].beatNumber).toBe(1)
  })

  it('sets correct timeMs for each beat', () => {
    const beats = beatsFromBpm(60, 10) // 1 beat/s → beat N at N*1000 ms
    expect(beats[0].timeMs).toBeCloseTo(0, 0)
    expect(beats[1].timeMs).toBeCloseTo(1000, 0)
    expect(beats[2].timeMs).toBeCloseTo(2000, 0)
  })
})

describe('beatsFromMarkers', () => {
  it('maps isDownbeat markers to beatNumber 1', () => {
    const markers = [
      { positionMs: 0, bpm: 120, isDownbeat: true },
      { positionMs: 500, bpm: 120, isDownbeat: false },
      { positionMs: 1000, bpm: 120, isDownbeat: false },
      { positionMs: 1500, bpm: 120, isDownbeat: false },
      { positionMs: 2000, bpm: 120, isDownbeat: true },
    ]
    const beats = beatsFromMarkers(markers, 120)
    expect(beats[0].beatNumber).toBe(1)
    expect(beats[1].beatNumber).toBe(2)
    expect(beats[4].beatNumber).toBe(1)
  })

  it('uses fallbackBpm when marker bpm is 0', () => {
    const markers = [{ positionMs: 0, bpm: 0, isDownbeat: true }]
    const beats = beatsFromMarkers(markers, 128)
    expect(beats[0].bpm).toBe(128)
  })
})

describe('buildDatAnlz', () => {
  it('produces a buffer with PMAI header', () => {
    const beats = beatsFromBpm(128, 30)
    const dat = buildDatAnlz({ audioPath: '/Contents/Offcut/test.mp3', beats })
    expect(dat.slice(0, 4).toString('ascii')).toBe('PMAI')
    expect(dat.length).toBeGreaterThan(100)
  })

  it('contains a PQTZ section with the right beat count', () => {
    const beats = beatsFromBpm(120, 60) // 120 beats
    const dat = buildDatAnlz({ audioPath: '/Contents/x.mp3', beats })
    let pos = dat.readUInt32BE(4) // skip PMAI header
    let numBeats = 0
    while (pos + 12 <= dat.length) {
      const tag = dat.slice(pos, pos + 4).toString('ascii')
      if (tag === 'PQTZ') {
        numBeats = dat.readUInt32BE(pos + 20)
        break
      }
      pos += dat.readUInt32BE(pos + 8)
    }
    expect(numBeats).toBe(120)
  })

  it('contains PPTH with the audio path (big-endian UTF-16)', () => {
    const beats = beatsFromBpm(120, 5)
    const dat = buildDatAnlz({ audioPath: '/Contents/Offcut/my-track.mp3', beats })
    let pos = dat.readUInt32BE(4)
    let foundPath = ''
    while (pos + 12 <= dat.length) {
      const tag = dat.slice(pos, pos + 4).toString('ascii')
      if (tag === 'PPTH') {
        const lenHeader = dat.readUInt32BE(pos + 4)
        const lenTag = dat.readUInt32BE(pos + 8)
        // UTF-16BE → decode by swapping each pair of bytes → UTF-16LE
        const textBuf = Buffer.from(dat.slice(pos + lenHeader, pos + lenTag))
        for (let i = 0; i + 1 < textBuf.length; i += 2) {
          const tmp = textBuf[i]; textBuf[i] = textBuf[i + 1]; textBuf[i + 1] = tmp
        }
        foundPath = textBuf.toString('utf16le')
        break
      }
      pos += dat.readUInt32BE(pos + 8)
    }
    expect(foundPath).toBe('/Contents/Offcut/my-track.mp3')
  })

  it('advances cleanly through all sections (no section overlap)', () => {
    const beats = beatsFromBpm(130, 20)
    const dat = buildDatAnlz({ audioPath: '/Contents/x.mp3', beats })
    let pos = dat.readUInt32BE(4)
    const tags: string[] = []
    while (pos + 8 <= dat.length) {
      const tag = dat.slice(pos, pos + 4).toString('ascii')
      const lenTag = dat.readUInt32BE(pos + 8)
      if (lenTag < 8) break
      tags.push(tag)
      pos += lenTag
    }
    expect(tags).toContain('PPTH')
    expect(tags).toContain('PQTZ')
    expect(tags).toContain('PWAV')
    expect(tags).toContain('PWV2')
    expect(tags).toContain('PCOB')
    expect(pos).toBe(dat.length) // walked exactly to end
  })
})
