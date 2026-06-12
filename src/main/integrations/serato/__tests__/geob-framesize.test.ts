import { describe, it, expect } from 'vitest'
import { parseID3Frames } from '../geob'

// ── ID3v2 frame-size encoding helpers ───────────────────────────────────────

/** v2.4 synchsafe: 7 significant bits per byte, top bit cleared. */
function synchsafe(size: number): Buffer {
  return Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ])
}

/** v2.3 plain big-endian uint32. */
function plain(size: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(size, 0)
  return b
}

/**
 * Build a single ID3 frame: 4-byte id + 4-byte size + 2 flag bytes + payload.
 * `sizeFn` controls how the declared size is encoded on the wire.
 */
function frame(id: string, payload: Buffer, sizeFn: (n: number) => Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    sizeFn(payload.length),
    Buffer.from([0x00, 0x00]), // frame flags
    payload,
  ])
}

/** A GEOB payload carrying a Serato description, as parseID3Frames expects. */
function geobPayload(description: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]),                       // text encoding
    Buffer.from('application/octet-stream\0'), // mime + \0
    Buffer.from('\0'),                         // empty filename + \0
    Buffer.from(description, 'latin1'),
    Buffer.from('\0'),                         // description + \0
    content,
  ])
}

// The first frame is deliberately >127 bytes so that the synchsafe and plain
// encodings of its size diverge: 200 → synchsafe [0,0,1,72] but a plain
// readUInt32BE of those same bytes yields 328. Mis-reading it as 328 walks the
// cursor past the GEOB frame and into garbage, so the GEOB is never located.
const FIRST_FRAME_LEN = 200

function framesRegion(sizeFn: (n: number) => Buffer): { buf: Buffer; geobContent: Buffer } {
  const geobContent = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  const tit2 = frame('TIT2', Buffer.alloc(FIRST_FRAME_LEN, 0x41), sizeFn) // 'A' * 200
  const geob = frame('GEOB', geobPayload('Serato Markers2', geobContent), sizeFn)
  return { buf: Buffer.concat([tit2, geob]), geobContent }
}

describe('parseID3Frames — ID3v2.4 synchsafe frame sizes', () => {
  it('locates a GEOB frame sitting after a frame whose size would be mis-read as a plain uint32', () => {
    const { buf, geobContent } = framesRegion(synchsafe)
    const frames = parseID3Frames(buf, 4)
    expect(frames.has('Serato Markers2')).toBe(true)
    expect(frames.get('Serato Markers2')).toEqual(geobContent)
  })

  it('mis-reads the same v2.4 bytes when forced down the v2.3 plain path (proves the version check matters)', () => {
    const { buf } = framesRegion(synchsafe)
    // Decoding synchsafe sizes as plain uint32 overshoots the first frame and
    // hides the GEOB — exactly the original bug.
    const frames = parseID3Frames(buf, 3)
    expect(frames.has('Serato Markers2')).toBe(false)
  })

  it('still parses genuine ID3v2.3 (plain uint32) frames — no regression', () => {
    const { buf, geobContent } = framesRegion(plain)
    const frames = parseID3Frames(buf, 3)
    expect(frames.has('Serato Markers2')).toBe(true)
    expect(frames.get('Serato Markers2')).toEqual(geobContent)
  })
})
