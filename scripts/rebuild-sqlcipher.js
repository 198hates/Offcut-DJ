#!/usr/bin/env node
/**
 * Rebuilds better-sqlite3-multiple-ciphers for the project's installed Electron version.
 * Run this once after npm install: node scripts/rebuild-sqlcipher.js
 */

const { execSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ELECTRON_PATH = path.join(ROOT, 'node_modules', 'electron')
const BSMC_PATH = path.join(ROOT, 'node_modules', 'better-sqlite3-multiple-ciphers')

if (!existsSync(BSMC_PATH)) {
  console.error('better-sqlite3-multiple-ciphers not installed. Run npm install first.')
  process.exit(1)
}

const versionFile = path.join(ELECTRON_PATH, 'dist', 'version')
if (!existsSync(versionFile)) {
  console.error('Electron binary not found. Run node node_modules/electron/install.js first.')
  process.exit(1)
}

const electronVersion = readFileSync(versionFile, 'utf8').trim()
const arch = process.arch
const platform = process.platform

console.log(`Building better-sqlite3-multiple-ciphers for Electron ${electronVersion} (${platform}/${arch})...`)

const cmd = [
  'npx', '@electron/rebuild',
  '--module-dir', BSMC_PATH,
  '--target', electronVersion,
  '--arch', arch,
  '--runtime', 'electron',
].join(' ')

try {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
  console.log('✓ better-sqlite3-multiple-ciphers rebuilt successfully.')
} catch (err) {
  console.error('Build failed. If on ARM64 macOS, make sure Xcode Command Line Tools are installed.')
  console.error('Run: xcode-select --install')
  process.exit(1)
}
