#!/usr/bin/env node
/**
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron scripts/test-sqlcipher.js
 * Tests better-sqlite3-multiple-ciphers against the Rekordbox master.db
 */
const path = require('path')
const os   = require('os')
const fs   = require('fs')

const RB_KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'
const masterDbPath = path.join(os.homedir(), 'Library', 'Pioneer', 'rekordbox', 'master.db')

let SqlCipherDatabase
try {
  SqlCipherDatabase = require('better-sqlite3-multiple-ciphers')
  console.log('✓ Module loaded:', SqlCipherDatabase.name)
} catch (e) {
  console.error('✗ Module load failed:', e.message)
  process.exit(1)
}

// ── Self-test: create and read back an encrypted DB ───────────────────────────
const tmpPath = path.join(os.tmpdir(), '_crate_selftest.db')
try {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  const w = new SqlCipherDatabase(tmpPath)
  w.pragma("cipher='sqlcipher'"); w.pragma('legacy=4')
  w.pragma(`key="x'${RB_KEY}'"`)
  w.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES ("hello")')
  w.close()
  const r = new SqlCipherDatabase(tmpPath, { readonly: true })
  r.pragma("cipher='sqlcipher'"); r.pragma('legacy=4')
  r.pragma(`key="x'${RB_KEY}'"`)
  const rows = r.prepare('SELECT * FROM t').all()
  r.close()
  fs.unlinkSync(tmpPath)
  console.log('✓ Self-test passed — cipher works. Rows:', rows)
} catch (e) {
  console.error('✗ Self-test FAILED — cipher module broken:', e.message)
  console.error('  Run: npm run rebuild:sqlcipher')
  process.exit(1)
}

// ── Try opening master.db ─────────────────────────────────────────────────────
console.log('\nOpening:', masterDbPath)
if (!fs.existsSync(masterDbPath)) {
  console.error('✗ File not found')
  process.exit(1)
}

const attempts = [
  ['cipher_compat=4 + hexkey',    db => { db.pragma('cipher_compatibility=4'); db.pragma(`hexkey="${RB_KEY}"`) }],
  ['sqlcipher+legacy4+hexkey',    db => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.pragma(`hexkey="${RB_KEY}"`) }],
  ['sqlcipher+legacy4+x-hex key', db => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.pragma(`key="x'${RB_KEY}'"`) }],
  ['cipher_compat=4+x-hex key',   db => { db.pragma('cipher_compatibility=4'); db.pragma(`key="x'${RB_KEY}'"`) }],
  ['x-hex key only',              db => { db.pragma(`key="x'${RB_KEY}'"`) }],
  ['passphrase only',             db => { db.pragma(`key="${RB_KEY}"`) }],
]

let opened = false
for (const [label, setup] of attempts) {
  let db = null
  try {
    db = new SqlCipherDatabase(masterDbPath, { readonly: true })
    setup(db)
    const result = db.prepare('SELECT COUNT(*) as c FROM djmdContent').get()
    console.log(`\n✓ SUCCESS with: ${label}`)
    console.log(`  Track count: ${result.c}`)
    opened = true
    db.close()
    break
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`)
    try { db?.close() } catch {}
  }
}

if (!opened) console.error('\n✗ Could not open master.db with any cipher configuration.')
