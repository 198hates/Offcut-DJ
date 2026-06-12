#!/usr/bin/env node
/**
 * M2a end-to-end validation: add a brand-new track to a (fake) USB — copy
 * audio into /Contents, write its ANLZ .DAT (beatgrid + preview), insert the
 * track_row pointing at both — then verify the whole chain by re-reading:
 *   pdb → new track present → file_path audio exists → analyze_path ANLZ exists
 *   → ANLZ beatgrid valid.
 *
 * Operates entirely under /tmp; never touches a real stick.
 *
 * Usage: node scripts/test-add-track-to-usb.cjs /path/to/pristine/export.pdb
 */
const fs = require('fs')
const path = require('path')
const KS = require('kaitai-struct/KaitaiStream')
const RekordboxPdb = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxPdb.cjs')
const RekordboxAnlz = require('../src/main/integrations/rekordbox-usb/kaitai/RekordboxAnlz.cjs')
const { addTrack, readTracks } = require('./test-write-track.cjs')
const { buildDat } = require('./test-write-anlz.cjs')

const srcPdb = process.argv[2]
if (!srcPdb) { console.error('pass a pristine export.pdb'); process.exit(1) }

// ── Set up a throwaway fake USB ──────────────────────────────────────────────
const USB = '/tmp/fakeusb-m2a'
fs.rmSync(USB, { recursive: true, force: true })
fs.mkdirSync(path.join(USB, 'PIONEER', 'rekordbox'), { recursive: true })
fs.mkdirSync(path.join(USB, 'Contents', 'Offcut'), { recursive: true })
fs.copyFileSync(srcPdb, path.join(USB, 'PIONEER', 'rekordbox', 'export.pdb'))

// A stand-in source audio file (content irrelevant for the structural test).
const srcAudio = '/tmp/njc1-analysis/offcut-sample.mp3'
fs.writeFileSync(srcAudio, Buffer.alloc(64 * 1024, 0x55))

// ── addTrackToUsb (the flow we'll port to writer.ts) ─────────────────────────
function addTrackToUsb(usbRoot, opts) {
  const pdbPath = path.join(usbRoot, 'PIONEER', 'rekordbox', 'export.pdb')
  const pdb = fs.readFileSync(pdbPath)
  const tracks = readTracks(pdb)
  const newId = tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1

  // 1. Copy audio into /Contents.
  const fileName = path.basename(opts.audioFilePath)
  const deviceFilePath = `/Contents/Offcut/${fileName}`
  fs.copyFileSync(opts.audioFilePath, path.join(usbRoot, 'Contents', 'Offcut', fileName))

  // 2. Allocate an ANLZ dir + write the .DAT.
  const hex = newId.toString(16).toUpperCase().padStart(8, '0')
  const anlzDirDevice = `/PIONEER/USBANLZ/OFCT/${hex}`
  const analyzePath = `${anlzDirDevice}/ANLZ0000.DAT`
  fs.mkdirSync(path.join(usbRoot, 'PIONEER', 'USBANLZ', 'OFCT', hex), { recursive: true })
  const dat = buildDat({ audioPath: deviceFilePath, bpm: opts.bpm, durationSec: opts.durationSec })
  fs.writeFileSync(path.join(usbRoot, analyzePath.replace(/^\//, '')), dat)

  // 3. Insert the track_row.
  const out = addTrack(pdb, {
    id: newId, title: opts.title, bpm: opts.bpm, duration: opts.durationSec,
    filePath: deviceFilePath, filename: fileName, analyzePath,
    bitrate: opts.bitrate || 320, fileSize: fs.statSync(opts.audioFilePath).size
  })
  fs.writeFileSync(pdbPath, out)
  return { newId, deviceFilePath, analyzePath }
}

// ── Run + verify ─────────────────────────────────────────────────────────────
const before = readTracks(fs.readFileSync(path.join(USB, 'PIONEER', 'rekordbox', 'export.pdb'))).length
const res = addTrackToUsb(USB, {
  audioFilePath: srcAudio, title: 'Offcut Fresh Import', bpm: 126, durationSec: 200
})
console.log(`added track id ${res.newId} (${before} → ${before + 1} tracks)`)

const pdbAfter = fs.readFileSync(path.join(USB, 'PIONEER', 'rekordbox', 'export.pdb'))
const tracks = readTracks(pdbAfter)
const t = tracks.find((x) => x.id === res.newId)

const audioOnStick = fs.existsSync(path.join(USB, t.filePath.replace(/^\//, '')))
const anlzOnStick = fs.existsSync(path.join(USB, t.analyzePath.replace(/^\//, '')))
let beats = 0
if (anlzOnStick) {
  const a = new RekordboxAnlz(new KS(fs.readFileSync(path.join(USB, t.analyzePath.replace(/^\//, '')))))
  for (const s of a.sections) if ((s.fourcc >>> 0) === 0x5051545a) beats = s.body.numBeats
}

console.log('\n── verify the chain ──')
console.log('  track in pdb           :', t ? `YES (${t.title})` : 'NO')
console.log('  file_path              :', t.filePath)
console.log('  audio file on stick    :', audioOnStick ? 'YES' : 'NO')
console.log('  analyze_path           :', t.analyzePath)
console.log('  ANLZ file on stick     :', anlzOnStick ? 'YES' : 'NO')
console.log('  ANLZ beatgrid beats    :', beats)
console.log('  existing tracks count  :', tracks.length === before + 1 ? 'OK (+1)' : 'WRONG')

const ok = t && t.title === 'Offcut Fresh Import' && audioOnStick && anlzOnStick && beats > 0 && tracks.length === before + 1
console.log('\n' + (ok ? '✅ END-TO-END M2a FLOW VALID — track + audio + beatgrid all on the stick' : '❌ FAILED'))
fs.rmSync(USB, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
