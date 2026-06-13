// Generate Rekordbox ANLZ analysis files (`.DAT` + `.EXT`) for a track — the
// files a CDJ reads for beat grids, waveforms and cues so it doesn't have to
// re-analyse on load. Ported from morizkraemer/fourfour's pioneer-usb-writer,
// whose layout is confirmed readable on real CDJ-3000 hardware.
//
// Two things are critical for the CDJ to actually use these files:
//   1. They must live at the HASH-COMPUTED path (PIONEER/USBANLZ/Pxxx/xxxxxxxx/)
//      — the CDJ recomputes the path from the audio file's USB path and ignores
//      the analyze_path stored in export.pdb. See anlzDirForPath().
//   2. The CDJ-3000 requires the `.EXT` file (colour waveforms) to consider a
//      track analysed. Without it, it re-analyses every track on load.
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

export interface AnlzCue {
  /** 0 = memory cue, >0 = hot cue (A=1, B=2, …). */
  hotCueNumber: number
  /** Cue position in ms. */
  timeMs: number
  /** Loop end in ms, if this is a loop. */
  loopTimeMs?: number
}

// ── PMAI container ────────────────────────────────────────────────────────────

function pmaiFile(sections: Buffer[]): Buffer {
  const body = Buffer.concat(sections)
  const head = Buffer.alloc(0x1c)
  head.write('PMAI', 0, 'ascii')
  head.writeUInt32BE(0x1c, 4) // header length
  head.writeUInt32BE(0x1c + body.length, 8) // total file size
  head.writeUInt32BE(1, 0x0c) // unknown (1 in rekordbox exports)
  head.writeUInt32BE(0x0001_0000, 0x10) // unknown (0x10000 in rekordbox)
  head.writeUInt32BE(0x0001_0000, 0x14) // unknown (0x10000 in rekordbox)
  return Buffer.concat([head, body])
}

// ── Shared sections (.DAT and .EXT) ──────────────────────────────────────────

// PPTH — audio file path (device-relative), UTF-16BE with a null terminator.
// The null terminator is required for the CDJ's path matching.
function ppth(usbPath: string): Buffer {
  const text = Buffer.from(usbPath, 'utf16le').swap16() // → UTF-16BE
  const pathBytes = Buffer.concat([text, Buffer.from([0, 0])]) // + null terminator
  const head = Buffer.alloc(16)
  head.write('PPTH', 0, 'ascii')
  head.writeUInt32BE(16, 4)
  head.writeUInt32BE(16 + pathBytes.length, 8)
  head.writeUInt32BE(pathBytes.length, 12)
  return Buffer.concat([head, pathBytes])
}

// PCOB — cue/loop list with PCPT entries (type 1 = hot cues, 0 = memory cues).
function pcob(type: 0 | 1, cues: AnlzCue[]): Buffer {
  const head = Buffer.alloc(24)
  head.write('PCOB', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + cues.length * 56, 8)
  head.writeUInt32BE(type, 12)
  head.writeUInt32BE(cues.length, 16)
  // hot cues always 0xFFFFFFFF; memory cues use 0 when entries are present.
  head.writeUInt32BE(cues.length && type === 0 ? 0 : 0xffffffff, 20)

  const entries = cues.map((cue) => {
    const e = Buffer.alloc(56)
    e.write('PCPT', 0, 'ascii')
    e.writeUInt32BE(28, 4) // header_len
    e.writeUInt32BE(56, 8) // entry_len
    e.writeUInt32BE(cue.hotCueNumber, 12)
    // 0x10: status (4 zero bytes)
    e.writeUInt16BE(0x0001, 20)
    // 0x16: unknown (2 zero bytes)
    e.writeUInt32BE(0xffffffff, 24) // 0x18 sentinel
    e.writeUInt8(0x01, 28) // 0x1c type (1 = cue)
    e.writeUInt16BE(0x03e8, 30) // 0x1e loop denominator
    e.writeUInt32BE(Math.round(cue.timeMs) >>> 0, 32) // 0x20 time_ms
    e.writeUInt32BE(cue.loopTimeMs != null ? Math.round(cue.loopTimeMs) >>> 0 : 0xffffffff, 36) // 0x24 loop_time
    return e
  })
  return Buffer.concat([head, ...entries])
}

// ── .DAT sections ─────────────────────────────────────────────────────────────

// PVBR — VBR seek table. Always 1620 bytes; zero-filled (fine for CBR/FLAC).
function pvbr(): Buffer {
  const buf = Buffer.alloc(1620)
  buf.write('PVBR', 0, 'ascii')
  buf.writeUInt32BE(16, 4) // header_len
  buf.writeUInt32BE(1620, 8) // total_len
  return buf
}

// PQTZ — beat grid.
function pqtz(beats: AnlzBeat[]): Buffer {
  const head = Buffer.alloc(24)
  head.write('PQTZ', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + beats.length * 8, 8)
  head.writeUInt32BE(0, 12) // unknown1
  head.writeUInt32BE(0x0008_0000, 16) // unknown2 (beat entry size marker)
  head.writeUInt32BE(beats.length, 20)
  const body = Buffer.alloc(beats.length * 8)
  beats.forEach((b, i) => {
    body.writeUInt16BE(b.beatNumber & 0xffff, i * 8)
    body.writeUInt16BE(Math.round(b.bpm * 100) & 0xffff, i * 8 + 2)
    body.writeUInt32BE(Math.round(b.timeMs) >>> 0, i * 8 + 4)
  })
  return Buffer.concat([head, body])
}

// PWAV — 400-byte monochrome waveform preview.
function pwav(mono: Uint8Array): Buffer {
  const head = Buffer.alloc(20)
  head.write('PWAV', 0, 'ascii')
  head.writeUInt32BE(20, 4)
  head.writeUInt32BE(20 + mono.length, 8)
  head.writeUInt32BE(mono.length, 12)
  // 0x10: padding (4 zero bytes)
  return Buffer.concat([head, Buffer.from(mono)])
}

// ── .EXT colour-waveform sections ─────────────────────────────────────────────
// When real 3-band spectral envelopes are supplied (see waveform.ts) the colour
// waveforms encode true bass/mid/treble; otherwise they fall back to a white
// (full-spectrum) tint derived from the monochrome preview — still enough for
// the CDJ to treat the track as analysed and render a waveform.

/** Per-bucket amplitude envelopes (0..1). Length is independent of section size. */
export interface AnlzBands {
  peaks: ArrayLike<number>
  low: ArrayLike<number>
  mid: ArrayLike<number>
  high: ArrayLike<number>
}

function monoAt(mono: Uint8Array, i: number, count: number): number {
  return mono[Math.min(mono.length - 1, Math.floor((i * mono.length) / Math.max(1, count)))]
}

/** Resample a 0..1 envelope to entry `i` of `count`. */
function samp(arr: ArrayLike<number>, i: number, count: number): number {
  const idx = Math.min(arr.length - 1, Math.floor((i * arr.length) / Math.max(1, count)))
  return arr[idx]
}
const clamp = (v: number, max: number): number => Math.max(0, Math.min(max, Math.round(v)))

// PWV3 — monochrome detail scroll (1 byte/entry; duration_secs * 150 entries).
// Byte: bits 7-5 = whiteness (saturation, brighter with treble), bits 4-0 =
// height (0..31). Matches real exports: treble lifts whiteness, not height.
function pwv3(mono: Uint8Array, count: number, bands?: AnlzBands): Buffer {
  const head = Buffer.alloc(24)
  head.write('PWV3', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + count, 8)
  head.writeUInt32BE(1, 12)
  head.writeUInt32BE(count, 16)
  head.writeUInt32BE(0x0096_0000, 20)
  const body = Buffer.alloc(count)
  for (let i = 0; i < count; i++) {
    if (bands) {
      const lo = samp(bands.low, i, count)
      const md = samp(bands.mid, i, count)
      const hi = samp(bands.high, i, count)
      const height = clamp(Math.max(lo, md, hi) * 31, 31)
      const whiteness = clamp(hi * 7, 7)
      body[i] = (whiteness << 5) | (height & 0x1f)
    } else {
      const height = monoAt(mono, i, count) & 0x1f
      body[i] = (2 << 5) | height
    }
  }
  return Buffer.concat([head, body])
}

// PWV5 — colour detail scroll (2 bytes/entry; duration_secs * 150 entries).
// 16-bit BE: [red:3][green:3][blue:3][height:5][unused:2]. Real exports map
// mid→red, treble→green, bass→blue (verified by decoding a rekordbox stick).
function pwv5(mono: Uint8Array, count: number, bands?: AnlzBands): Buffer {
  const head = Buffer.alloc(24)
  head.write('PWV5', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + count * 2, 8)
  head.writeUInt32BE(2, 12)
  head.writeUInt32BE(count, 16)
  head.writeUInt32BE(0x0096_0305, 20)
  const body = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i++) {
    let r: number, g: number, b: number, h: number
    if (bands) {
      const lo = samp(bands.low, i, count)
      const md = samp(bands.mid, i, count)
      const hi = samp(bands.high, i, count)
      r = clamp(md * 7, 7) // mid → red
      g = clamp(hi * 7, 7) // treble → green
      b = clamp(lo * 7, 7) // bass → blue
      h = clamp(Math.max(lo, md, hi) * 31, 31)
    } else {
      h = monoAt(mono, i, count) & 0x1f
      r = 0
      g = 0
      b = h >> 2 // bluish monochrome
    }
    body.writeUInt16BE(((r & 7) << 13) | ((g & 7) << 10) | ((b & 7) << 7) | ((h & 0x1f) << 2), i * 2)
  }
  return Buffer.concat([head, body])
}

// PWV4 — colour preview (6 bytes/entry; 1200 entries; 0..255). Bytes per column:
// [whiteness, whiteness, bottom-half energy, low, mid, high].
function pwv4(mono: Uint8Array, bands?: AnlzBands): Buffer {
  const n = 1200
  const head = Buffer.alloc(24)
  head.write('PWV4', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + n * 6, 8)
  head.writeUInt32BE(6, 12)
  head.writeUInt32BE(n, 16)
  // 0x14: unknown (4 zero bytes)
  const body = Buffer.alloc(n * 6)
  for (let i = 0; i < n; i++) {
    const o = i * 6
    if (bands) {
      const lo = samp(bands.low, i, n)
      const md = samp(bands.mid, i, n)
      const hi = samp(bands.high, i, n)
      const overall = clamp(Math.max(lo, md, hi) * 255, 255)
      body[o] = overall // whiteness / top stripe
      body[o + 1] = overall // whiteness / second stripe
      body[o + 2] = clamp(Math.max(lo, md) * 255, 255) // bottom-half energy
      body[o + 3] = clamp(lo * 255, 255) // bottom third
      body[o + 4] = clamp(md * 255, 255) // middle
      body[o + 5] = clamp(hi * 255, 255) // top
    } else {
      const height = Math.round(((monoAt(mono, i, n) & 0x1f) * 255) / 31)
      body[o] = height
      body[o + 1] = height
      body[o + 2] = height
      body[o + 3] = 0
      body[o + 4] = 0
      body[o + 5] = height // bluish
    }
  }
  return Buffer.concat([head, body])
}

// PWV7 — 3-band detail scroll (3 bytes/entry; duration_secs * 150). CDJ-3000.
// Byte order [mid, high, low], each 0..127 (verified against real exports).
function pwv7(count: number, bands?: AnlzBands): Buffer {
  const head = Buffer.alloc(24)
  head.write('PWV7', 0, 'ascii')
  head.writeUInt32BE(24, 4)
  head.writeUInt32BE(24 + count * 3, 8)
  head.writeUInt32BE(3, 12)
  head.writeUInt32BE(count, 16)
  head.writeUInt32BE(0x0096_0000, 20)
  const body = Buffer.alloc(count * 3)
  if (bands) {
    for (let i = 0; i < count; i++) {
      body[i * 3] = clamp(samp(bands.mid, i, count) * 127, 127)
      body[i * 3 + 1] = clamp(samp(bands.high, i, count) * 127, 127)
      body[i * 3 + 2] = clamp(samp(bands.low, i, count) * 127, 127)
    }
  }
  return Buffer.concat([head, body])
}

// PWV6 — 3-band preview (3 bytes/entry; 1200 entries). CDJ-3000.
// Byte order [mid, high, low], each 0..127. No trailing unknown field.
function pwv6(bands?: AnlzBands): Buffer {
  const n = 1200
  const head = Buffer.alloc(20)
  head.write('PWV6', 0, 'ascii')
  head.writeUInt32BE(20, 4)
  head.writeUInt32BE(20 + n * 3, 8)
  head.writeUInt32BE(3, 12)
  head.writeUInt32BE(n, 16)
  const body = Buffer.alloc(n * 3)
  if (bands) {
    for (let i = 0; i < n; i++) {
      body[i * 3] = clamp(samp(bands.mid, i, n) * 127, 127)
      body[i * 3 + 1] = clamp(samp(bands.high, i, n) * 127, 127)
      body[i * 3 + 2] = clamp(samp(bands.low, i, n) * 127, 127)
    }
  }
  return Buffer.concat([head, body])
}

// PWVC — small 3-band colour/scale summary that the CDJ-3000 requires for the
// .2EX to be accepted (without it the player falls back to the .EXT colour
// waveform). 20 bytes: header (tag + 14 + 20 + 2 zero) then three uint16 derived
// from the track's average mid/high/low levels.
function pwvc(bands: AnlzBands): Buffer {
  const buf = Buffer.alloc(20)
  buf.write('PWVC', 0, 'ascii')
  buf.writeUInt32BE(14, 4) // header length
  buf.writeUInt32BE(20, 8) // total length
  // 0x0c: 2 zero bytes
  const avg = (a: ArrayLike<number>): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i]
    return a.length ? s / a.length : 0
  }
  buf.writeUInt16BE(clamp(avg(bands.mid) * 255 * 1.5, 255), 14)
  buf.writeUInt16BE(clamp(avg(bands.high) * 255 * 1.5, 255), 16)
  buf.writeUInt16BE(clamp(avg(bands.low) * 255 * 1.5, 255), 18)
  return buf
}

// PCO2 — extended cue/loop list with PCP2 entries.
function pco2(type: 0 | 1, cues: AnlzCue[]): Buffer {
  const head = Buffer.alloc(20)
  head.write('PCO2', 0, 'ascii')
  head.writeUInt32BE(20, 4)
  head.writeUInt32BE(20 + cues.length * 88, 8)
  head.writeUInt32BE(type, 12)
  head.writeUInt16BE(cues.length & 0xffff, 16)
  // 0x12: padding (2 zero bytes)

  const entries = cues.map((cue) => {
    const e = Buffer.alloc(88)
    e.write('PCP2', 0, 'ascii')
    e.writeUInt32BE(16, 4) // header_len
    e.writeUInt32BE(88, 8) // entry_len
    e.writeUInt32BE(cue.hotCueNumber, 12)
    e.writeUInt8(0x01, 16) // type (1 = cue)
    e.writeUInt16BE(0x03e8, 18) // loop denominator
    e.writeUInt32BE(Math.round(cue.timeMs) >>> 0, 20)
    e.writeUInt32BE(cue.loopTimeMs != null ? Math.round(cue.loopTimeMs) >>> 0 : 0xffffffff, 24)
    e.writeUInt16BE(0x0001, 28)
    return e
  })
  return Buffer.concat([head, ...entries])
}

// PQT2 — extended beat grid.
function pqt2(beats: AnlzBeat[], durationSecs: number): Buffer {
  const head = Buffer.alloc(56)
  head.write('PQT2', 0, 'ascii')
  head.writeUInt32BE(56, 4)
  head.writeUInt32BE(56 + beats.length * 2, 8)
  // 0x0c: unknown1 (zero)
  head.writeUInt32BE(0x0100_0002, 16) // flags/version
  // 0x14, 0x18: unknown2 / timing1 (zero)
  head.writeUInt32BE(2, 28) // unknown3
  // 0x20: timing2 (zero)
  head.writeUInt32BE(Math.round(durationSecs * 1000) >>> 0, 36) // track duration ms
  head.writeUInt32BE(beats.length, 40) // beat count
  // 0x2c, 0x30, 0x34: unknown4/5/6 (zero)
  const body = Buffer.alloc(beats.length * 2)
  beats.forEach((b, i) => {
    const tempoEncoded = (Math.round(b.bpm * 100) & 0x03ff) >>> 0
    const beatNum = (b.beatNumber & 0x0f) << 10
    body.writeUInt16BE((beatNum | tempoEncoded) & 0xffff, i * 2)
  })
  return Buffer.concat([head, body])
}

// PVB2 — extended VBR info. Always 8032 bytes; zero-filled.
function pvb2(): Buffer {
  const buf = Buffer.alloc(8032)
  buf.write('PVB2', 0, 'ascii')
  buf.writeUInt32BE(32, 4) // header_len
  buf.writeUInt32BE(8032, 8) // total_len
  return buf
}

// ── Monochrome preview helper ────────────────────────────────────────────────

/** Build the 400-byte monochrome preview shared by the .DAT and .EXT files. */
function buildMonoPreview(peaks?: ArrayLike<number>): Uint8Array {
  const len = 400
  const prev = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const amp = peaks && peaks.length ? peaks[Math.floor((i / len) * peaks.length)] : 0.5
    const height = Math.max(0, Math.min(31, Math.round((amp || 0) * 31)))
    prev[i] = (4 << 5) | height // whiteness 4 (mid)
  }
  return prev
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

// ── Path hashing ──────────────────────────────────────────────────────────────

/**
 * Pioneer's ANLZ path hash. The CDJ computes this from the audio file's
 * USB-relative path and uses it to LOCATE the ANLZ files — it ignores the
 * analyze_path stored in export.pdb. ANLZ files must live at the resulting path
 * or the CDJ re-analyses the track.
 */
function computeAnlzPathHash(usbPath: string): { pValue: number; hash: number } {
  let hash = 0 >>> 0
  for (const ch of usbPath) {
    const codeUnit = ch.charCodeAt(0) & 0xffff
    const temp = (Math.imul(hash, 0x5bc9) + codeUnit) >>> 0
    hash = (Math.imul(temp, 0x93b5) + codeUnit) >>> 0
  }
  const hashResult = hash % 0x30d43 // modulo 200003
  let p = 0
  p |= (hashResult >> 0) & 1
  p |= (hashResult >> 1) & 2
  p |= (hashResult >> 4) & 4
  p |= (hashResult >> 4) & 8
  p |= (hashResult >> 5) & 0x10
  p |= (hashResult >> 8) & 0x20
  p |= (hashResult >> 10) & 0x40
  return { pValue: p & 0xffff, hash: hashResult }
}

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0')

/**
 * USB-relative ANLZ directory for an audio path, e.g.
 * `PIONEER/USBANLZ/P0A3/0001F8B2`. No leading slash.
 */
export function anlzDirForPath(usbPath: string): string {
  const { pValue, hash } = computeAnlzPathHash(usbPath)
  return `PIONEER/USBANLZ/P${hex(pValue, 3)}/${hex(hash, 8)}`
}

// ── Build the files ───────────────────────────────────────────────────────────

export interface BuildAnlzOptions {
  /** Device-relative path of the audio file, e.g. /Contents/Offcut/x.mp3 */
  audioPath: string
  beats: AnlzBeat[]
  /** Track duration in seconds (drives .EXT colour-waveform resolution). */
  durationSecs?: number
  /** Optional amplitude peaks (0..1) to render the preview; flat otherwise. */
  peaks?: number[]
  /** Optional 3-band spectral envelopes for true-colour waveforms (see waveform.ts). */
  bands?: AnlzBands
  /** Hot cues + memory cues; defaults to none. */
  cues?: AnlzCue[]
}

/**
 * Build the ANLZ `.DAT`: path + VBR + beat grid + mono preview + cue lists,
 * in the section order rekordbox writes (PPTH → PVBR → PQTZ → PWAV → PCOB hot
 * → PCOB memory).
 */
export function buildDatAnlz(opts: BuildAnlzOptions): Buffer {
  const mono = buildMonoPreview(opts.bands?.peaks ?? opts.peaks)
  const cues = opts.cues ?? []
  const hot = cues.filter((c) => c.hotCueNumber > 0)
  const memory = cues.filter((c) => c.hotCueNumber === 0)
  return pmaiFile([ppth(opts.audioPath), pvbr(), pqtz(opts.beats), pwav(mono), pcob(1, hot), pcob(0, memory)])
}

/**
 * Build the ANLZ `.EXT`: colour waveforms + extended cues + extended beat grid.
 * The CDJ-3000 requires this file to treat a track as analysed (otherwise it
 * re-analyses on load). Section order: PPTH → PWV3 → PCOB → PCOB → PCO2 → PCO2
 * → PQT2 → PWV5 → PWV4 → PVB2. (The 3-band PWV6/PWV7 live in the .2EX file, not
 * here — see build2exAnlz.)
 */
export function buildExtAnlz(opts: BuildAnlzOptions): Buffer {
  const mono = buildMonoPreview(opts.bands?.peaks ?? opts.peaks)
  const bands = opts.bands
  const duration = opts.durationSecs ?? 0
  const count = Math.max(0, Math.round(duration * 150))
  const cues = opts.cues ?? []
  const hot = cues.filter((c) => c.hotCueNumber > 0)
  const memory = cues.filter((c) => c.hotCueNumber === 0)
  return pmaiFile([
    ppth(opts.audioPath),
    pwv3(mono, count, bands),
    pcob(1, []), // EXT PCOBs are always empty; real cues go in PCO2
    pcob(0, []),
    pco2(1, hot),
    pco2(0, memory),
    pqt2(opts.beats, duration),
    pwv5(mono, count, bands),
    pwv4(mono, bands),
    pvb2()
  ])
}

/**
 * Build the ANLZ `.2EX` (second extended analysis): the CDJ-3000's native
 * minimalist 3-band waveforms — PWV6 (1200-column preview) + PWV7
 * (≈150 columns/sec detail scroll). When present the CDJ-3000 renders these
 * instead of the older PWV4/PWV5 colour waveforms. Returns null when there's no
 * spectral data to put in them (a .2EX of empty bands is pointless).
 */
export function build2exAnlz(opts: BuildAnlzOptions): Buffer | null {
  if (!opts.bands) return null
  const duration = opts.durationSecs ?? 0
  const count = Math.max(1, Math.round(duration * 150))
  // Section order matches real exports: PPTH → PWV7 → PWV6 → PWVC.
  return pmaiFile([ppth(opts.audioPath), pwv7(count, opts.bands), pwv6(opts.bands), pwvc(opts.bands)])
}
