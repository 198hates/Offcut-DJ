// Offline licence-key validation.
//
// A key looks like  OFFCUT-XXXX-XXXX-XXXX-YYYY  where the first three groups are
// a free serial and the last group is an HMAC check derived from them + a secret
// baked into the build. The owner mints keys with mintLicenceKey() (see
// scripts/mint-licence.mjs); the app validates them with isValidLicenceKey().
//
// NOTE: the secret ships inside the application bundle, so this gates casual
// copying and key-sharing — not a determined reverse-engineer. For hard DRM you
// would validate against a server. This is deliberate for a not-for-resale build.

import crypto from 'crypto'

// Change this before any public/commercial release so pre-release keys don't carry over.
const SECRET = 'offcut.licence.v1.7b3c9f2a'
// Crockford-ish alphabet — no I/O/0/1 so keys are easy to read out loud / type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const KEY_RE = /^OFFCUT-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/

function checkGroup(serial: string): string {
  const h = crypto.createHmac('sha256', SECRET).update(serial.toUpperCase()).digest()
  let out = ''
  for (let i = 0; i < 4; i++) out += ALPHABET[h[i] % ALPHABET.length]
  return out
}

/** True when `raw` is a well-formed, correctly-checksummed Offcut licence key. */
export function isValidLicenceKey(raw: string): boolean {
  const key = (raw || '').trim().toUpperCase()
  const m = KEY_RE.exec(key)
  if (!m) return false
  const [, a, b, c, check] = m
  const expected = checkGroup(a + b + c)
  try {
    return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(expected))
  } catch {
    return false
  }
}

/** Mint a valid key from a 12-char serial (owner-side; used by the key-gen script). */
export function mintLicenceKey(serial: string): string {
  const s = (serial || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12)
    .padEnd(12, 'X')
  const a = s.slice(0, 4)
  const b = s.slice(4, 8)
  const c = s.slice(8, 12)
  return `OFFCUT-${a}-${b}-${c}-${checkGroup(a + b + c)}`
}
