import { describe, it, expect } from 'vitest'
import { buildDatAnlz, buildExtAnlz, build2exAnlz, anlzDirForPath, beatsFromBpm, type AnlzBands } from '../anlz'
import { computeWaveformBands } from '../waveform'

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

// A section's data region (after its 24- or 20-byte header).
function sectionData(buf: Buffer, tag: string, headerLen: number): Buffer {
  let off = 0x1c
  while (off + 12 <= buf.length) {
    const total = buf.readUInt32BE(off + 8)
    if (buf.toString('ascii', off, off + 4) === tag) return buf.subarray(off + headerLen, off + total)
    off += total
  }
  throw new Error(`section ${tag} not found`)
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
    // 3-band PWV6/PWV7 live in the .2EX file, NOT here.
    expect(sections(ext).map((s) => s.tag)).toEqual([
      'PPTH', 'PWV3', 'PCOB', 'PCOB', 'PCO2', 'PCO2', 'PQT2', 'PWV5', 'PWV4', 'PVB2'
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

  const bandsOf = (n: number, lo: number, md: number, hi: number): AnlzBands => ({
    peaks: new Float32Array(n).fill(Math.max(lo, md, hi)),
    low: new Float32Array(n).fill(lo),
    mid: new Float32Array(n).fill(md),
    high: new Float32Array(n).fill(hi)
  })

  it('packs PWV5 as [red:3][green:3][blue:3][height:5] with a real height', () => {
    // Bass-dominant → red high, height non-zero (the bug fourfour had: height≈0).
    const ext = buildExtAnlz({ ...opts, bands: bandsOf(200, 1, 0.1, 0.1) })
    const pwv5 = sectionData(ext, 'PWV5', 24)
    const v = pwv5.readUInt16BE(0)
    const red = (v >> 13) & 7
    const green = (v >> 10) & 7
    const blue = (v >> 7) & 7
    const height = (v >> 2) & 0x1f
    expect(red).toBe(7) // bass maxed
    expect(blue).toBeLessThan(red) // treble quiet
    expect(height).toBe(31) // NOT zero — this is the flat-line fix
    expect(green).toBeGreaterThanOrEqual(0)

    // Treble-dominant → blue high.
    const v2 = sectionData(buildExtAnlz({ ...opts, bands: bandsOf(200, 0.1, 0.1, 1) }), 'PWV5', 24).readUInt16BE(0)
    expect((v2 >> 7) & 7).toBe(7) // blue maxed
    expect((v2 >> 13) & 7).toBeLessThan(7) // red quiet
  })
})

describe('ANLZ .2EX (CDJ-3000 3-band)', () => {
  const bands: AnlzBands = {
    peaks: new Float32Array(200).fill(1),
    low: new Float32Array(200).fill(1), // → 255
    mid: new Float32Array(200).fill(0.5), // → ~128
    high: new Float32Array(200).fill(0) // → 0
  }

  it('contains PWV6 + PWV7 with [mid, high, low] byte order', () => {
    const two = build2exAnlz({ ...opts, bands })!
    expect(two).not.toBeNull()
    expect(two.toString('ascii', 0, 4)).toBe('PMAI')
    const tags = sections(two).map((s) => s.tag)
    expect(tags).toEqual(['PPTH', 'PWV6', 'PWV7'])

    const pwv7 = sectionData(two, 'PWV7', 24)
    // byte order [mid, high, low] → [128, 0, 255]
    expect(pwv7[0]).toBeGreaterThanOrEqual(127)
    expect(pwv7[0]).toBeLessThanOrEqual(128)
    expect(pwv7[1]).toBe(0)
    expect(pwv7[2]).toBe(255)
  })

  it('is null without spectral bands (no point writing empty 3-band data)', () => {
    expect(build2exAnlz(opts)).toBeNull()
  })
})

describe('computeWaveformBands', () => {
  it('puts a low sine in the bass band and a high sine in the treble band', () => {
    const sr = 22050
    const dur = 2
    const make = (freq: number): Float32Array => {
      const s = new Float32Array(sr * dur)
      for (let i = 0; i < s.length; i++) s[i] = Math.sin((2 * Math.PI * freq * i) / sr)
      return s
    }
    const bass = computeWaveformBands(make(60), sr, 300)
    const treble = computeWaveformBands(make(8000), sr, 300)
    // Each band is normalised to 1.0; the dominant band for each signal should
    // clearly exceed the others at a representative (settled) bucket.
    const mid = 200
    expect(bass.low[mid]).toBeGreaterThan(bass.high[mid])
    expect(treble.high[mid]).toBeGreaterThan(treble.low[mid])
  })

  it('returns empty bands for empty input', () => {
    const b = computeWaveformBands(new Float32Array(0), 22050, 100)
    expect(b.low.length).toBe(100)
    expect(b.low.every((v) => v === 0)).toBe(true)
  })
})
