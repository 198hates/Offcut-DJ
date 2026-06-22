// electron-builder configuration.
//
// Moved out of package.json so the two heavyweight, platform-specific extras —
// the Demucs PyInstaller sidecar (~600 MB) and the beat-detection ONNX model —
// can be bundled ONLY when they're present. A lean build (or a CI run without
// them) then succeeds instead of hard-failing on a missing `from` path. The app
// degrades gracefully: stems fall back to the user's system Python + Demucs, and
// beat-detection analysis is disabled until the model is added to userData/models.
const { existsSync } = require('fs')
const { join } = require('path')

// Always bundled.
const extraResources = [
  {
    from: 'src/main/integrations/rekordbox-usb/templates',
    to: 'rekordbox',
    filter: ['empty-export.pdb', '*.DAT', '*.bin']
  },
  // The Rust audio engine, built per-platform by `npm run engine:build` (copies
  // the host-arch cdylib to this fixed name). On a native runner host == target.
  { from: 'native/audio-engine/crate-audio-engine.node', to: 'crate-audio-engine.node' }
]

// Optional heavy extras — include only if built/provided.
const DEMUCS = 'build/demucs-dist/offcut-demucs'
const MODEL = 'build/models/beat_this.onnx'
if (existsSync(join(__dirname, DEMUCS))) {
  extraResources.push({ from: DEMUCS, to: 'offcut-demucs', filter: ['**/*'] })
} else {
  console.warn('[electron-builder] Demucs sidecar absent — shipping lean (stems use system Python).')
}
if (existsSync(join(__dirname, MODEL))) {
  extraResources.push({ from: MODEL, to: 'models/beat_this.onnx' })
} else {
  console.warn('[electron-builder] beat_this.onnx absent — shipping without it (beat analysis disabled until added).')
}

module.exports = {
  appId: 'co.betweenthebridges.offcut',
  productName: 'Offcut',
  copyright: 'Copyright © 2026 Between the Bridges',
  directories: { buildResources: 'resources', output: 'dist' },
  files: ['out/**/*'],
  extraResources,
  asarUnpack: [
    '**/node_modules/better-sqlite3/**/*.node',
    '**/node_modules/better-sqlite3-multiple-ciphers/**/*.node',
    '**/node_modules/onnxruntime-node/**/*.node',
    '**/node_modules/onnxruntime-node/bin/**',
    '**/node_modules/ffmpeg-static/ffmpeg',
    '**/node_modules/ffmpeg-static/ffmpeg.exe',
    'out/main/beat-analysis-worker.js'
  ],
  publish: { provider: 'github', owner: '198Hates', repo: 'DJ', releaseType: 'release' },
  mac: {
    category: 'public.app-category.music',
    icon: 'resources/icon.icns',
    // Unsigned for now — users right-click → Open past Gatekeeper. Add an Apple
    // Developer ID + notarisation here when ready.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    extendInfo: {
      NSDesktopFolderUsageDescription: 'Offcut reads your music files to analyse and play them.',
      NSDocumentsFolderUsageDescription: 'Offcut reads your music files to analyse and play them.',
      NSDownloadsFolderUsageDescription: 'Offcut reads your music files to analyse and play them.',
      NSRemovableVolumesUsageDescription: 'Offcut reads music files stored on external drives.'
    },
    // No explicit arch here on purpose: arch is chosen per-build by the CLI flag
    // (--arm64 / --x64), so each run produces exactly one arch. Listing
    // ['arm64','x64'] would override the flag and make a single --arm64 run ALSO
    // cross-build x64 (which can't produce correct x64 ffmpeg/onnx on an arm64
    // host). Intel is built natively on an Intel Mac via `npm run build:mac:x64`.
    target: [{ target: 'dmg' }, { target: 'zip' }]
  },
  dmg: {
    title: '${productName} ${version}',
    artifactName: '${productName}-${version}-mac-${arch}.dmg'
  },
  win: {
    icon: 'resources/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-win-x64-setup.exe'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Offcut'
  },
  linux: {
    target: ['AppImage'],
    icon: 'resources/icon.png',
    category: 'Audio',
    artifactName: '${productName}-${version}-linux-${arch}.AppImage'
  }
}
