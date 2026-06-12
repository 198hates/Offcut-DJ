#!/usr/bin/env node
/**
 * M2a validation: generate a minimal ANLZ .DAT (PMAI + PPTH path + PQTZ beat
 * grid + PWAV/PWV2 preview waveform + empty PCOB cue lists) and read it back
 * with the compiled ANLZ parser to confirm every section round-trips.
 *
 * ANLZ is BIG-ENDIAN (unlike export.pdb).
 */
const fs = require('fs')
const KS = require('kaitai-struct/KaitaiStream')
const RekordboxAnlz = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxAnlz.cjs')

const fourcc = (s) => Buffer.from(s, 'ascii')

// ── Sections (all big-endian) ───────────────────────────────────────────────

// PPTH — audio file path, UTF-16BE.
function ppth(audioPath) {
  const text = Buffer.from(audioPath, 'utf16le').swap16() // → UTF-16BE
  const lenPath = text.length + 2 // + 2-byte null terminator
  const head = Buffer.alloc(16)
  head.write('PPTH', 0, 'ascii')
  head.writeUInt32BE(16, 4)               // len_header
  head.writeUInt32BE(16 + text.length, 8) // len_tag
  head.writeUInt32BE(lenPath, 12)         // len_path
  return Buffer.concat([head, text])
}

// PQTZ — beat grid. beats: [{ beatNumber(1-4), bpm, timeMs }]
function pqtz(beats) {
  const head = Buffer.alloc(24)
  head.write('PQTZ', 0, 'ascii')
  head.writeUInt32BE(24, 4)                       // len_header
  head.writeUInt32BE(24 + beats.length * 8, 8)    // len_tag
  head.writeUInt32BE(0, 12)
  head.writeUInt32BE(0x80000, 16)
  head.writeUInt32BE(beats.length, 20)            // num_beats
  const body = Buffer.alloc(beats.length * 8)
  beats.forEach((b, i) => {
    body.writeUInt16BE(b.beatNumber & 0xffff, i * 8)
    body.writeUInt16BE(Math.round(b.bpm * 100) & 0xffff, i * 8 + 2)
    body.writeUInt32BE(Math.round(b.timeMs) >>> 0, i * 8 + 4)
  })
  return Buffer.concat([head, body])
}

// PWAV / PWV2 — monochrome preview waveform. data: Uint8Array of bytes
// (bits 0-4 = height 0-31, bits 5-7 = whiteness 0-7).
function wavePreview(tag, data) {
  const head = Buffer.alloc(20)
  head.write(tag, 0, 'ascii')
  head.writeUInt32BE(20, 4)              // len_header
  head.writeUInt32BE(20 + data.length, 8) // len_tag
  head.writeUInt32BE(data.length, 12)    // len_data
  head.writeUInt32BE(0x10000, 16)
  return Buffer.concat([head, Buffer.from(data)])
}

// PCOB — an (empty) cue list. type 0 = memory cues, 1 = hot cues.
function pcob(type) {
  const b = Buffer.alloc(24)
  b.write('PCOB', 0, 'ascii')
  b.writeUInt32BE(24, 4)   // len_header
  b.writeUInt32BE(24, 8)   // len_tag (no entries)
  b.writeUInt32BE(type, 12)
  b.writeUInt16BE(0, 16)
  b.writeUInt16BE(0, 18)   // num_cues
  b.writeUInt32BE(0, 20)   // memory_count
  return b
}

function pmaiFile(sections) {
  const body = Buffer.concat(sections)
  const head = Buffer.alloc(0x1c)
  head.write('PMAI', 0, 'ascii')
  head.writeUInt32BE(0x1c, 4)            // len_header
  head.writeUInt32BE(0x1c + body.length, 8) // len_file
  return Buffer.concat([head, body])
}

// ── Build a sample .DAT ──────────────────────────────────────────────────────
function buildDat({ audioPath, bpm, durationSec, peaks }) {
  // Beat grid from bpm/offset across the duration.
  const beatMs = 60000 / bpm
  const beats = []
  let n = 0
  for (let t = 0; t < durationSec * 1000; t += beatMs) {
    beats.push({ beatNumber: (n % 4) + 1, bpm, timeMs: t })
    n++
  }
  // 400-segment preview from peaks (fallback: gentle ramp).
  const previewLen = 400
  const prev = new Uint8Array(previewLen)
  for (let i = 0; i < previewLen; i++) {
    const amp = peaks ? peaks[Math.floor((i / previewLen) * peaks.length)] : 0.4 + 0.4 * Math.sin(i / 12)
    const height = Math.max(0, Math.min(31, Math.round(amp * 31)))
    const whiteness = 4 // mid
    prev[i] = (whiteness << 5) | height
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

module.exports = { buildDat, ppth, pqtz, wavePreview, pcob, pmaiFile }
if (require.main !== module) return

// ── Build + validate ─────────────────────────────────────────────────────────
const dat = buildDat({
  audioPath: '/Contents/Offcut/offcut-test.mp3',
  bpm: 124,
  durationSec: 215
})
fs.writeFileSync('/tmp/njc1-analysis/ANLZ-test.DAT', dat)
console.log(`built .DAT: ${dat.length} bytes`)

const a = new RekordboxAnlz(new KS(dat))
const TAGS = { 0x50505448: 'PPTH', 0x5051545a: 'PQTZ', 0x50574156: 'PWAV', 0x50575632: 'PWV2', 0x50434f42: 'PCOB' }
console.log('sections read back:')
let beatGridOk = false, pathOk = false, wavOk = false
for (const s of a.sections) {
  const tag = TAGS[s.fourcc >>> 0] || ('0x' + (s.fourcc >>> 0).toString(16))
  let detail = ''
  if (tag === 'PQTZ') { detail = `num_beats=${s.body.numBeats}, beat[0]=${s.body.beats[0].beatNumber}@${s.body.beats[0].time}ms tempo ${s.body.beats[0].tempo}`; beatGridOk = s.body.numBeats > 0 && s.body.beats[0].tempo === 12400 }
  if (tag === 'PPTH') { detail = `path="${s.body.path}"`; pathOk = s.body.path === '/Contents/Offcut/offcut-test.mp3' }
  if (tag === 'PWAV') { detail = `len_data=${s.body.lenData}`; wavOk = s.body.lenData === 400 }
  console.log(`  ${tag} (len_tag ${s.lenTag}) ${detail}`)
}
const ok = beatGridOk && pathOk && wavOk
console.log('\n' + (ok ? '✅ ANLZ .DAT round-trips (beatgrid + path + preview all valid)' : '❌ validation failed'))
process.exit(ok ? 0 : 1)
