import { describe, it, expect } from 'vitest'
import { buildDatAnlz, buildExtAnlz, anlzDirForPath, beatsFromBpm } from '../anlz'

// Collect every "XXXX" section tag (4 ASCII bytes followed by a header_len and
// total_len) by walking the PMAI body using the declared section sizes.
function sections(buf: Buffer): { tag: string; total: number }[] {
  const out: { tag: string; total: number }[] = []
  let off = 0x1c // skip PMAI header
  while (off + 12 <= buf.length) {
    const tag = buf.toString('ascii', off, off + 4)
    const total = buf.readUInt32BE(off + 8)
    if (total <= 0) break
    out.push({ tag, total })
    off += total
  }
  return out
}

const opts = {
  audioPath: '/Contents/Offcut/0000000A_track.mp3',
  beats: beatsFromBpm(128, 180),
  durationSecs: 180
}

describe('ANLZ hash path', () => {
  it('is deterministic and well-formed', () => {
    const dir = anlzDirForPath('/Contents/Offcut/0000000A_track.mp3')
    expect(dir).toMatch(/^PIONEER\/USBANLZ\/P[0-9A-F]{3}\/[0-9A-F]{8}$/)
    // Stable across calls (CDJ recomputes the same path).
    expect(anlzDirForPath('/Contents/Offcut/0000000A_track.mp3')).toBe(dir)
  })

  it('differs for different paths', () => {
    expect(anlzDirForPath('/Contents/a.mp3')).not.toBe(anlzDirForPath('/Contents/b.mp3'))
  })
})

describe('ANLZ .DAT', () => {
  it('has the PMAI header and rekordbox section order', () => {
    const dat = buildDatAnlz(opts)
    expect(dat.toString('ascii', 0, 4)).toBe('PMAI')
    expect(dat.readUInt32BE(8)).toBe(dat.length) // total size matches
    expect(sections(dat).map((s) => s.tag)).toEqual(['PPTH', 'PVBR', 'PQTZ', 'PWAV', 'PCOB', 'PCOB'])
  })

  it('PVBR is 1620 bytes and PWAV carries 400 preview bytes', () => {
    const s = sections(buildDatAnlz(opts))
    expect(s.find((x) => x.tag === 'PVBR')!.total).toBe(1620)
    expect(s.find((x) => x.tag === 'PWAV')!.total).toBe(420) // 20 header + 400
  })
})

describe('ANLZ .EXT', () => {
  it('has the colour-waveform sections the CDJ-3000 needs', () => {
    const ext = buildExtAnlz(opts)
    expect(ext.toString('ascii', 0, 4)).toBe('PMAI')
    expect(ext.readUInt32BE(8)).toBe(ext.length)
    expect(sections(ext).map((s) => s.tag)).toEqual([
      'PPTH', 'PWV3', 'PCOB', 'PCOB', 'PCO2', 'PCO2', 'PQT2', 'PWV5', 'PWV4', 'PWV7', 'PWV6', 'PVB2'
    ])
  })

  it('colour-waveform entry counts scale with duration (150/sec)', () => {
    const s = sections(buildExtAnlz(opts))
    const count = 180 * 150
    expect(s.find((x) => x.tag === 'PWV3')!.total).toBe(24 + count) // 1 byte/entry
    expect(s.find((x) => x.tag === 'PWV5')!.total).toBe(24 + count * 2) // 2 bytes/entry
    expect(s.find((x) => x.tag === 'PWV4')!.total).toBe(24 + 1200 * 6) // fixed 1200 entries
    expect(s.find((x) => x.tag === 'PVB2')!.total).toBe(8032)
  })
})
