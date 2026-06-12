import { describe, it, expect } from 'vitest'
import {
  encodeSeratoUtf16BE,
  decodeSeratoUtf16BE,
  toSeratoPath,
  fromSeratoPath,
} from '../path'
import { buildCrateBuffer } from '../writer'
import { parseCrateFile } from '../reader'
import type { Track } from '../../../../shared/types'

// ── Encoding ──────────────────────────────────────────────────────────────────

describe('Serato UTF-16BE encoding', () => {
  it('encodes big-endian (high byte first)', () => {
    const buf = encodeSeratoUtf16BE('A') // U+0041
    expect(buf[0]).toBe(0x00)
    expect(buf[1]).toBe(0x41)
  })

  it('round-trips ASCII', () => {
    expect(decodeSeratoUtf16BE(encodeSeratoUtf16BE('Hello World'))).toBe('Hello World')
  })

  it('round-trips non-ASCII (accents, CJK)', () => {
    const s = 'Café — テスト'
    expect(decodeSeratoUtf16BE(encodeSeratoUtf16BE(s))).toBe(s)
  })

  it('does NOT match a naive little-endian decode (guards the original bug)', () => {
    const be = encodeSeratoUtf16BE('AB')
    expect(be.toString('utf16le')).not.toBe('AB')
  })
})

// ── Path conversion (posix; tests run on darwin) ──────────────────────────────

describe('Serato path conversion', () => {
  it('strips the leading slash for the on-disk form', () => {
    expect(toSeratoPath('/Users/dj/Music/track.mp3')).toBe('Users/dj/Music/track.mp3')
  })

  it('re-anchors to an absolute path on read', () => {
    expect(fromSeratoPath('Users/dj/Music/track.mp3')).toBe('/Users/dj/Music/track.mp3')
  })

  it('round-trips an absolute path', () => {
    const p = '/Users/dj/Music/My Track (Remix).mp3'
    expect(fromSeratoPath(toSeratoPath(p))).toBe(p)
  })
})

// ── Full crate buffer round-trip ──────────────────────────────────────────────

function track(filePath: string): Track {
  return {
    id: filePath, filePath, title: '', artist: '', album: '', genre: '',
    year: null, label: '', bpm: null, key: null, durationSeconds: null,
    rating: 0, dateAdded: '', comment: '', tags: [], customTags: {},
    cuePoints: [], beatgrid: [], energy: null, danceability: null, mood: null,
    analysedBeatgrid: null, editLineage: null, color: '', playCount: 0,
    lastPlayedAt: null, updatedAt: null, fileSize: null, fileType: null,
    sampleRate: null, bitDepth: null, gainDb: null, phrases: null, sourceIds: {},
  } as Track
}

describe('crate buffer round-trip', () => {
  it('writes a crate the reader parses back to the original absolute paths', () => {
    const paths = [
      '/Users/dj/Music/Daft Punk/Discovery/06 Night Vision.mp3',
      '/Users/dj/Music/Café del Mar/01 Intro.mp3',
    ]
    const buf = buildCrateBuffer(paths.map(track))
    expect(parseCrateFile(buf)).toEqual(paths)
  })

  it('starts with a vrsn record', () => {
    const buf = buildCrateBuffer([track('/Users/dj/x.mp3')])
    expect(buf.toString('ascii', 0, 4)).toBe('vrsn')
  })

  it('produces an empty list for a crate with no tracks', () => {
    expect(parseCrateFile(buildCrateBuffer([]))).toEqual([])
  })
})
