/**
 * Run with: ./node_modules/.bin/electron scripts/test-cipher.js
 * Tests every known SQLCipher combination against the Rekordbox master.db
 */
const path = require('path')

const KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'
const DB_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  'Library', 'Pioneer', 'rekordbox', 'master.db'
)

;(function main() {
  let SqlCipher
  try {
    SqlCipher = require('better-sqlite3-multiple-ciphers')
  } catch (e) {
    console.error('Failed to load better-sqlite3-multiple-ciphers:', e.message)
    process.exit(1)
    return
  }

  const attempts = [
    // --- Key first, then cipher settings (pyrekordbox-style) ---
    ['key-first: key-x then compat4',      (db) => { db.exec(`PRAGMA key="x'${KEY}'"`) ; db.pragma('cipher_compatibility=4') }],
    ['key-first: key-x then compat3',      (db) => { db.exec(`PRAGMA key="x'${KEY}'"`) ; db.pragma('cipher_compatibility=3') }],
    ['key-first: key-x then legacy4',      (db) => { db.exec(`PRAGMA key="x'${KEY}'"`) ; db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4') }],
    ['key-first: key-x then legacy3',      (db) => { db.exec(`PRAGMA key="x'${KEY}'"`) ; db.pragma("cipher='sqlcipher'"); db.pragma('legacy=3') }],
    ['key-first: hexkey then compat4',     (db) => { db.exec(`PRAGMA hexkey='${KEY}'`) ; db.pragma('cipher_compatibility=4') }],
    ['key-first: hexkey then compat3',     (db) => { db.exec(`PRAGMA hexkey='${KEY}'`) ; db.pragma('cipher_compatibility=3') }],
    // --- Cipher first (current approach) ---
    ['cipher-first: compat4 + key-x',     (db) => { db.pragma('cipher_compatibility=4') ; db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['cipher-first: compat3 + key-x',     (db) => { db.pragma('cipher_compatibility=3') ; db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['cipher-first: legacy4 + key-x',     (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['cipher-first: legacy3 + key-x',     (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=3'); db.exec(`PRAGMA key="x'${KEY}'"`) }],
    // --- Key as ASCII passphrase (not raw hex bytes) ---
    ['passphrase: compat4 + ascii-key',    (db) => { db.pragma('cipher_compatibility=4'); db.exec(`PRAGMA key='${KEY}'`) }],
    ['passphrase: compat3 + ascii-key',    (db) => { db.pragma('cipher_compatibility=3'); db.exec(`PRAGMA key='${KEY}'`) }],
    ['passphrase: legacy4 + ascii-key',    (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.exec(`PRAGMA key='${KEY}'`) }],
    ['passphrase: legacy3 + ascii-key',    (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=3'); db.exec(`PRAGMA key='${KEY}'`) }],
    // --- Explicit full SQLCipher 4 parameters ---
    ['explicit sc4: all params + key-x',   (db) => {
      db.exec(`PRAGMA cipher='sqlcipher'`)
      db.exec(`PRAGMA kdf_iter=256000`)
      db.exec(`PRAGMA cipher_page_size=4096`)
      db.exec(`PRAGMA cipher_hmac_algorithm=HMAC_SHA512`)
      db.exec(`PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512`)
      db.exec(`PRAGMA key="x'${KEY}'"`)
    }],
    // --- Explicit full SQLCipher 3 parameters ---
    ['explicit sc3: all params + key-x',   (db) => {
      db.exec(`PRAGMA cipher='sqlcipher'`)
      db.exec(`PRAGMA kdf_iter=64000`)
      db.exec(`PRAGMA cipher_page_size=1024`)
      db.exec(`PRAGMA cipher_hmac_algorithm=HMAC_SHA1`)
      db.exec(`PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA1`)
      db.exec(`PRAGMA key="x'${KEY}'"`)
    }],
    // --- Page size variants ---
    ['page1024: compat3 + key-x',          (db) => { db.pragma('cipher_compatibility=3'); db.exec(`PRAGMA cipher_page_size=1024`); db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['page4096: compat4 + key-x',          (db) => { db.pragma('cipher_compatibility=4'); db.exec(`PRAGMA cipher_page_size=4096`); db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['page2048: compat4 + key-x',          (db) => { db.pragma('cipher_compatibility=4'); db.exec(`PRAGMA cipher_page_size=2048`); db.exec(`PRAGMA key="x'${KEY}'"`) }],
    // --- Key only ---
    ['key-x only (no cipher pragma)',       (db) => { db.exec(`PRAGMA key="x'${KEY}'"`) }],
    ['hexkey only (no cipher pragma)',      (db) => { db.exec(`PRAGMA hexkey='${KEY}'`) }],
    // --- Without readonly (open r/w) ---
    ['rw-mode: compat4 + key-x',           (db, path) => {
      // This attempt opens rw - handled separately below
      db.pragma('cipher_compatibility=4'); db.exec(`PRAGMA key="x'${KEY}'"`)
    }],
    // --- chacha20 cipher (wxSQLite3 default) ---
    ['chacha20 + key-x',                   (db) => { db.pragma("cipher='chacha20'"); db.exec(`PRAGMA key="x'${KEY}'"`) }],
  ]

  let found = false
  for (const [label, setup] of attempts) {
    // Try both readonly and read-write for each attempt
    for (const ro of [true, false]) {
      let db = null
      try {
        db = new SqlCipher(DB_PATH, { readonly: ro })
        setup(db)
        const row = db.prepare('SELECT COUNT(*) as c FROM djmdContent').get()
        console.log(`\n✅ SUCCESS: "${label}" (readonly=${ro}) — ${row.c} tracks`)
        found = true
        db.close()
        break
      } catch (e) {
        console.log(`❌ FAIL: "${label}" (readonly=${ro}) → ${e.message}`)
        try { db && db.close() } catch {}
      }
    }
    if (found) break
  }

  if (!found) console.log('\nAll attempts failed.')
  process.exit(0)
})()
