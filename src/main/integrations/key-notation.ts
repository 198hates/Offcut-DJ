// Canonical key notation = Camelot ("8B" major / "1A" minor).
//
// The renderer's harmonic features (CamelotWheel, compatibility scoring, Magic
// Sort, key filter) all parse keys with /^(\d{1,2})([AB])$/, so EVERY importer
// must store keys in Camelot or those tracks silently drop out of harmonic
// workflows. These helpers convert the notations external libraries use.

const CAMELOT_RE = /^(\d{1,2})([AB])$/i

/** True if a string is already a Camelot code. */
export function isCamelot(s: string): boolean {
  return CAMELOT_RE.test(s.trim())
}

// ── Rekordbox djmdKey.ScaleName ("Cmaj" / "Amin") → Camelot ──────────────────
const RB_SCALE_TO_CAMELOT: Record<string, string> = {
  Cmaj: '8B', 'C#maj': '3B', Dbmaj: '3B', Dmaj: '10B', 'D#maj': '5B',
  Ebmaj: '5B', Emaj: '12B', Fmaj: '7B', 'F#maj': '2B', Gbmaj: '2B',
  Gmaj: '9B', 'G#maj': '4B', Abmaj: '4B', Amaj: '11B', 'A#maj': '6B',
  Bbmaj: '6B', Bmaj: '1B',
  Cmin: '5A', 'C#min': '12A', Dbmin: '12A', Dmin: '7A', 'D#min': '2A',
  Ebmin: '2A', Emin: '9A', Fmin: '4A', 'F#min': '11A', Gbmin: '11A',
  Gmin: '6A', 'G#min': '1A', Abmin: '1A', Amin: '8A', 'A#min': '3A',
  Bbmin: '3A', Bmin: '10A'
}

/** Rekordbox scale name (or an already-Camelot string) → Camelot, else null. */
export function rbScaleNameToCamelot(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (isCamelot(s)) return s.toUpperCase()
  return RB_SCALE_TO_CAMELOT[s] ?? null
}

// ── Traktor MUSICAL_KEY VALUE (0–23) ↔ Camelot ───────────────────────────────
// Traktor encodes the key as 0–23 over the open-key wheel: 0–11 major (1d…6d),
// 12–23 minor (1m…6m). We reuse that proven value↔open-key table and add the
// well-defined open-key↔Camelot bijection on top, so the round-trip is exact.
const VALUE_TO_OPENKEY = [
  '1d', '8d', '3d', '10d', '5d', '12d', '7d', '2d', '9d', '4d', '11d', '6d',
  '1m', '8m', '3m', '10m', '5m', '12m', '7m', '2m', '9m', '4m', '11m', '6m'
]
const OPENKEY_TO_VALUE: Record<string, number> = Object.fromEntries(
  VALUE_TO_OPENKEY.map((ok, i) => [ok, i])
)

/** Open-key code ("8d"/"3m") → Camelot. Camelot# = ((N+6) mod 12)+1; d→B, m→A. */
function openKeyToCamelot(ok: string): string | null {
  const m = /^(\d{1,2})([dm])$/.exec(ok.toLowerCase())
  if (!m) return null
  const n = Number(m[1])
  if (n < 1 || n > 12) return null
  const camNum = ((n + 6) % 12) + 1
  return `${camNum}${m[2] === 'd' ? 'B' : 'A'}`
}

/** Camelot → open-key code (inverse of openKeyToCamelot). */
function camelotToOpenKey(cam: string): string | null {
  const m = CAMELOT_RE.exec(cam.trim())
  if (!m) return null
  const c = Number(m[1])
  if (c < 1 || c > 12) return null
  let n = (c - 1 + 6) % 12
  if (n === 0) n = 12
  return `${n}${m[2].toUpperCase() === 'B' ? 'd' : 'm'}`
}

/** Traktor key value 0–23 → Camelot, else null. */
export function traktorValueToCamelot(value: number | null | undefined): string | null {
  if (value == null || value < 0 || value >= VALUE_TO_OPENKEY.length) return null
  return openKeyToCamelot(VALUE_TO_OPENKEY[value])
}

/** Camelot → Traktor key value 0–23, else null. */
export function camelotToTraktorValue(cam: string | null | undefined): number | null {
  if (!cam) return null
  const ok = camelotToOpenKey(cam)
  if (ok == null) return null
  const v = OPENKEY_TO_VALUE[ok]
  return v == null ? null : v
}
