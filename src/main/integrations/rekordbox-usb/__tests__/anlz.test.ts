import { describe, it, expect } from 'vitest'
import { buildDatAnlz, buildExtAnlz, anlzDirForPath, beatsFromBpm, type AnlzBands } from '../anlz'
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

  // Find a section's data region (after its 24- or 20-byte header).
  function sectionData(buf: Buffer, tag: string, headerLen: number): Buffer {
    let off = 0x1c
    while (off + 12 <= buf.length) {
      const total = buf.readUInt32BE(off + 8)
      if (buf.toString('ascii', off, off + 4) === tag) return buf.subarray(off + headerLen, off + total)
      off += total
    }
    throw new Error(`section ${tag} not found`)
  }

  it('encodes the dominant band into PWV3 colour bits', () => {
    const n = 200
    const bass: AnlzBands = {
      peaks: new Float32Array(n).fill(1),
      low: new Float32Array(n).fill(1), // bass dominant everywhere
      mid: new Float32Array(n).fill(0.1),
      high: new Float32Array(n).fill(0.1)
    }
    const ext = buildExtAnlz({ ...opts, bands: bass })
    const pwv3 = sectionData(ext, 'PWV3', 24)
    // colour bits (top 3) should be 1 (red/bass); height (low 5) near full.
    const colour = pwv3[0] >> 5
    const height = pwv3[0] & 0x1f
    expect(colour).toBe(1)
    expect(height).toBe(31)

    // Flip dominance to treble → colour bits 2 (blue).
    const treble: AnlzBands = { ...bass, low: new Float32Array(n).fill(0.1), high: new Float32Array(n).fill(1) }
    const pwv3b = sectionData(buildExtAnlz({ ...opts, bands: treble }), 'PWV3', 24)
    expect(pwv3b[0] >> 5).toBe(2)
  })

  it('PWV7 carries the raw 3-band bytes (low/mid/high)', () => {
    const n = 200
    const bands: AnlzBands = {
      peaks: new Float32Array(n).fill(1),
      low: new Float32Array(n).fill(1), // → 255
      mid: new Float32Array(n).fill(0.5), // → ~128
      high: new Float32Array(n).fill(0) // → 0
    }
    const pwv7 = sectionData(buildExtAnlz({ ...opts, bands }), 'PWV7', 24)
    expect(pwv7[0]).toBe(255)
    expect(pwv7[1]).toBeGreaterThanOrEqual(127)
    expect(pwv7[1]).toBeLessThanOrEqual(128)
    expect(pwv7[2]).toBe(0)
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
