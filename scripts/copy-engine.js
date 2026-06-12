/**
 * Copies the built native audio engine to
 *   native/audio-engine/crate-audio-engine.node
 * — the path the main process loads in development AND the file
 * electron-builder packs via extraResources for production.
 * Run automatically by `engine:build` / `engine:dev` and the platform
 * build scripts.
 *
 * NOTE: never overwrite this file while the app is running — the OS has it
 * mmap'd and the running process will crash on the next page-in. Quit the
 * app first, copy, then relaunch.
 */
const fs = require('fs')
const path = require('path')

const profile = process.argv.includes('--debug') ? 'debug' : 'release'
const root = path.join(__dirname, '..')
const targetDir = path.join(root, 'native', 'audio-engine', 'target', profile)
const names = ['libcrate_audio_engine.dylib', 'crate_audio_engine.dll', 'libcrate_audio_engine.so']
const src = names.map((n) => path.join(targetDir, n)).find((p) => fs.existsSync(p))

if (!src) {
  console.error(`[engine] no built library in ${targetDir} — run cargo build first`)
  process.exit(1)
}

const dest = path.join(root, 'native', 'audio-engine', 'crate-audio-engine.node')
fs.copyFileSync(src, dest)
console.log(`[engine] ${path.relative(root, src)} -> ${path.relative(root, dest)}`)
