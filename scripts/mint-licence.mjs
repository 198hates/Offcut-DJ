#!/usr/bin/env node
// Mint an Offcut licence key.
//   node scripts/mint-licence.mjs            → random serial
//   node scripts/mint-licence.mjs NATHAN01   → seeded serial (padded/truncated to 12)
//
// IMPORTANT: SECRET + ALPHABET must stay in sync with src/main/licence.ts.
import crypto from 'crypto'

const SECRET = 'offcut.licence.v1.7b3c9f2a'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

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

let serial = (process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
serial = (serial + rand(12)).slice(0, 12)
const a = serial.slice(0, 4), b = serial.slice(4, 8), c = serial.slice(8, 12)
console.log(`OFFCUT-${a}-${b}-${c}-${checkGroup(a + b + c)}`)
