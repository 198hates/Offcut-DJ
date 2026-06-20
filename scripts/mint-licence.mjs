#!/usr/bin/env node
// Offcut licence keys — mint new ones, or check an existing one.
//
//   node scripts/mint-licence.mjs                  → 1 random key
//   node scripts/mint-licence.mjs NATHAN01         → key with a seeded serial
//   node scripts/mint-licence.mjs -n 10            → 10 random keys
//   node scripts/mint-licence.mjs OFFCUT-AAAA-...  → check an existing key (VALID / INVALID)
//
// IMPORTANT: SECRET + ALPHABET must stay byte-identical with src/main/licence.ts,
// or keys minted here won't validate in the app.
import crypto from 'crypto'

const SECRET = 'offcut.licence.v2.5b85e53cf1c4d923755ae985a62abb05'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const KEY_RE = /^OFFCUT-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/

function checkGroup(serial) {
  const h = crypto.createHmac('sha256', SECRET).update(serial.toUpperCase()).digest()
  let o = ''
  for (let i = 0; i < 4; i++) o += ALPHABET[h[i] % ALPHABET.length]
  return o
}
function rand(n) {
  let o = ''
  for (let i = 0; i < n; i++) o += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return o
}
function mint(seed = '') {
  const serial = ((seed || '').toUpperCase().replace(/[^A-Z0-9]/g, '') + rand(12)).slice(0, 12)
  const a = serial.slice(0, 4), b = serial.slice(4, 8), c = serial.slice(8, 12)
  return `OFFCUT-${a}-${b}-${c}-${checkGroup(a + b + c)}`
}

const argv = process.argv.slice(2)
const first = argv[0] || ''

// Check mode: a full key was passed.
const m = KEY_RE.exec(first.trim().toUpperCase())
if (m) {
  const [, a, b, c, check] = m
  const ok = check === checkGroup(a + b + c)
  console.log(`${first.trim().toUpperCase()}  →  ${ok ? 'VALID ✓' : 'INVALID ✗'}`)
  process.exit(ok ? 0 : 1)
}

// Batch mint: -n / --count N.
if (first === '-n' || first === '--count') {
  const n = Math.max(1, parseInt(argv[1], 10) || 1)
  for (let i = 0; i < n; i++) console.log(mint())
  process.exit(0)
}

// Mint one (optionally seeded by a serial).
console.log(mint(first))
