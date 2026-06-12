// Generate a minimal Rekordbox ANLZ `.DAT` (the analysis file CDJs read for a
// track): path + beat grid + preview waveform + empty cue lists. Validated by
// round-trip against the compiled ANLZ parser.
//
// ANLZ is BIG-ENDIAN (export.pdb is little-endian — don't mix them up).

import type { BeatgridMarker } from '../../../shared/types'

export interface AnlzBeat {
  /** Position in the bar, 1 = downbeat. */
  beatNumber: number
  /** BPM at this beat. */
  bpm: number
  /** Time of the beat in ms. */
  timeMs: number
}

// ── Sections ────────────────────────────────────────────────────────────────

// PPTH — audio file path (device-relative), UTF-16BE.
function ppth(audioPath: string): Buffer {
  const text = Buffer.from(audioPath, 'utf16le').swap16() // → UTF-16BE
  const head = Buffer.alloc(16)
  head.write('PPTH', 0, 'ascii')
  head.writeUInt32BE(16, 4)
  head.writeUInt32BE(16 + text.length, 8)
  head.writeUInt32BE(text.length + 2, 12) // len_path incl 2-byte null
  return Buffer.concat([head, text])
}

// PQTZ — beat grid.
function pqtz(beats: AnlzBeat[]): Buffer {
  const head = Buffer.alloc(24)
  head.write('PQTZ', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + beats.length * 8, 8)
  head.writeUInt32BE(0, 12)
  head.writeUInt32BE(0x80000, 16)
  head.writeUInt32BE(beats.length, 20)
  const body = Buffer.alloc(beats.length * 8)
  beats.forEach((b, i) => {
    body.writeUInt16BE(b.beatNumber & 0xffff, i * 8)
    body.writeUInt16BE(Math.round(b.bpm * 100) & 0xffff, i * 8 + 2)
    body.writeUInt32BE(Math.round(b.timeMs) >>> 0, i * 8 + 4)
  })
  return Buffer.concat([head, body])
}

// PWAV / PWV2 — monochrome preview waveform (bits 0-4 height, 5-7 whiteness).
function wavePreview(tag: 'PWAV' | 'PWV2', data: Uint8Array): Buffer {
  const head = Buffer.alloc(20)
  head.write(tag, 0, 'ascii')
  head.writeUInt32BE(20, 4)
  head.writeUInt32BE(20 + data.length, 8)
  head.writeUInt32BE(data.length, 12)
  head.writeUInt32BE(0x10000, 16)
  return Buffer.concat([head, Buffer.from(data)])
}

// PCOB — an empty cue list (type 0 = memory cues, 1 = hot cues).
function pcob(type: 0 | 1): Buffer {
  const b = Buffer.alloc(24)
  b.write('PCOB', 0, 'ascii')
  b.writeUInt32BE(24, 4)
  b.writeUInt32BE(24, 8)
  b.writeUInt32BE(type, 12)
  b.writeUInt16BE(0, 16)
  b.writeUInt16BE(0, 18)
  b.writeUInt32BE(0, 20)
  return b
}

function pmaiFile(sections: Buffer[]): Buffer {
  const body = Buffer.concat(sections)
  const head = Buffer.alloc(0x1c)
  head.write('PMAI', 0, 'ascii')
  head.writeUInt32BE(0x1c, 4)
  head.writeUInt32BE(0x1c + body.length, 8)
  return Buffer.concat([head, body])
}

// ── Beat-grid derivation ──────────────────────────────────────────────────────

/** Beats from Offcut's stored markers (preferred — keeps the real downbeats). */
export function beatsFromMarkers(markers: BeatgridMarker[], fallbackBpm: number): AnlzBeat[] {
  const sorted = markers.slice().sort((a, b) => a.positionMs - b.positionMs)
  let beat = 0 // 1..4, reset on each downbeat
  return sorted.map((m) => {
    beat = m.isDownbeat ? 1 : beat >= 4 ? 1 : beat + 1
    return { beatNumber: beat, bpm: m.bpm || fallbackBpm, timeMs: m.positionMs }
  })
}

/** Beats synthesised from a constant tempo when no markers exist. */
export function beatsFromBpm(bpm: number, durationSec: number, offsetMs = 0): AnlzBeat[] {
  const beatMs = 60000 / bpm
  const beats: AnlzBeat[] = []
  let n = 0
  for (let t = offsetMs; t < durationSec * 1000; t += beatMs) {
    beats.push({ beatNumber: (n % 4) + 1, bpm, timeMs: t })
    n++
  }
  return beats
}

// ── Build the .DAT ────────────────────────────────────────────────────────────

export interface BuildDatOptions {
  /** Device-relative path of the audio file, e.g. /Contents/Offcut/x.mp3 */
  audioPath: string
  beats: AnlzBeat[]
  /** Optional amplitude peaks (0..1) to render the preview; flat otherwise. */
  peaks?: number[]
}

export function buildDatAnlz({ audioPath, beats, peaks }: BuildDatOptions): Buffer {
  const previewLen = 400
  const prev = new Uint8Array(previewLen)
  for (let i = 0; i < previewLen; i++) {
    const amp = peaks && peaks.length ? peaks[Math.floor((i / previewLen) * peaks.length)] : 0.5
    const height = Math.max(0, Math.min(31, Math.round((amp || 0) * 31)))
    prev[i] = (4 << 5) | height // whiteness 4 (mid)
  }
  const tiny = new Uint8Array(100)
  for (let i = 0; i < 100; i++) tiny[i] = prev[Math.floor((i / 100) * previewLen)]

  return pmaiFile([
    ppth(audioPath),
    pqtz(beats),
    wavePreview('PWAV', prev),
    wavePreview('PWV2', tiny),
    pcob(0),
    pcob(1)
  ])
}
