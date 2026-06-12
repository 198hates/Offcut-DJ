#!/usr/bin/env node
/**
 * Read-only inspector for an Engine DJ (Engine Library) Database2/m.db.
 *
 * Purpose: empirically verify the two reverse-engineered assumptions in
 * src/main/integrations/engine-dj/reader.ts that could NOT be checked when the
 * importer was written (no real m.db was available):
 *
 *   1. CUE STORAGE — reader.ts's getCuePoints() assumes a relational
 *      PerformanceData table with per-cue rows (type/startSample/endSample/
 *      sortIndex). The Mixxx reverse-engineering wiki instead documents PACKED
 *      BINARY BLOBS (quickCues/loops/beatData). This script prints the actual
 *      PerformanceData columns so you can tell which schema your DB uses.
 *
 *   2. SAMPLE RATE — getCuePoints() converts positions with a hardcoded 44100.
 *      This script reports any per-track sample-rate column so the real rate
 *      can be threaded into sampleToMs() instead of assumed.
 *
 *   3. KEY ENCODING — engineKeyToName() assumes Camelot order (1-24). The
 *      Mixxx wiki documents a CHROMATIC 0-23 encoding for older schemas. This
 *      script dumps the key value for a few named tracks so you can compare the
 *      stored integer against the track's known key.
 *
 * This opens the database READ-ONLY and never writes. Safe to run on your
 * real library.
 *
 * Usage:
 *   node scripts/inspect-engine-db.cjs ["/path/to/m.db"]
 *   # default path: ~/Music/Engine Library/Database2/m.db
 */
const path = require('path')
const fs = require('fs')

let Database
try {
  Database = require('better-sqlite3')
} catch {
  console.error('better-sqlite3 is not installed in this project. Run `npm install` first.')
  process.exit(1)
}

const home = process.env.HOME || process.env.USERPROFILE || ''
const dbPath = process.argv[2] || path.join(home, 'Music', 'Engine Library', 'Database2', 'm.db')

if (!fs.existsSync(dbPath)) {
  console.error(`No database at: ${dbPath}`)
  console.error('Pass the path explicitly: node scripts/inspect-engine-db.cjs "/path/to/m.db"')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })

function section(title) {
  console.log('\n' + '═'.repeat(72))
  console.log(title)
  console.log('═'.repeat(72))
}

function tableExists(name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name)
}

function columnsOf(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  } catch {
    return []
  }
}

try {
  section(`Engine Library: ${dbPath}`)

  // Schema version (newer Engine DJ keeps this in an Information table).
  if (tableExists('Information')) {
    try {
      console.log('Information row:', JSON.stringify(db.prepare('SELECT * FROM Information LIMIT 1').get()))
    } catch { /* ignore */ }
  }

  section('All tables')
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name)
  console.log(tables.join(', '))

  // ── (1) Cue storage: relational vs blob ────────────────────────────────────
  section('(1) PerformanceData — relational rows or packed blobs?')
  if (tableExists('PerformanceData')) {
    const cols = columnsOf('PerformanceData')
    console.log('Columns:', cols.join(', '))
    const relational = ['type', 'startSample', 'endSample', 'sortIndex']
    const blobby = ['quickCues', 'hotCues', 'loops', 'beatData', 'trackData']
    const hasRelational = relational.every((c) => cols.includes(c))
    const hasBlobs = blobby.some((c) => cols.includes(c))
    console.log(`reader.ts relational assumption (${relational.join('/')}): ${hasRelational ? 'PRESENT' : 'ABSENT'}`)
    console.log(`blob columns (${blobby.join('/')}): ${hasBlobs ? 'PRESENT' : 'absent'}`)
    if (!hasRelational && hasBlobs) {
      console.log('>>> VERDICT: cues are stored as BLOBS. reader.ts getCuePoints() will silently return [] for this DB — it needs a blob parser, not a relational query.')
    } else if (hasRelational) {
      console.log('>>> VERDICT: relational cue columns exist — reader.ts query shape matches. Verify type codes below.')
      try {
        const types = db.prepare('SELECT type, COUNT(*) n FROM PerformanceData GROUP BY type ORDER BY type').all()
        console.log('type histogram:', JSON.stringify(types))
        console.log('sample rows:', JSON.stringify(db.prepare('SELECT * FROM PerformanceData LIMIT 3').all()))
      } catch (e) { console.log('row sample failed:', e.message) }
    }
  } else {
    console.log('No PerformanceData table. Cue data may live elsewhere (e.g. a separate p.db, or a different table). Tables above are the full list.')
  }

  // ── (2) Sample rate source ──────────────────────────────────────────────────
  section('(2) Per-track sample rate — where does it live?')
  const trackCols = tableExists('Track') ? columnsOf('Track') : []
  const srCol = trackCols.find((c) => /sample.?rate/i.test(c))
  if (srCol) {
    console.log(`Track.${srCol} exists.`)
    try {
      const dist = db.prepare(`SELECT ${srCol} sr, COUNT(*) n FROM Track WHERE ${srCol} IS NOT NULL GROUP BY ${srCol} ORDER BY n DESC LIMIT 10`).all()
      console.log('distribution:', JSON.stringify(dist))
      console.log('>>> Thread this column into sampleToMs() instead of the 44100 default.')
    } catch (e) { console.log('query failed:', e.message) }
  } else {
    console.log('No sampleRate-like column on Track.')
    console.log('Track columns:', trackCols.join(', ') || '(no Track table)')
    console.log('If cues are in blobs, the sample rate is the first double in trackData/beatData (per Mixxx docs).')
  }

  // ── (3) Key encoding ─────────────────────────────────────────────────────────
  section('(3) Key encoding — Camelot (1-24) or chromatic (0-23)?')
  if (trackCols.includes('key')) {
    console.log('Track.key exists. Distribution of stored values:')
    try {
      const dist = db.prepare('SELECT key, COUNT(*) n FROM Track WHERE key IS NOT NULL GROUP BY key ORDER BY key').all()
      console.log(JSON.stringify(dist))
      const min = Math.min(...dist.map((d) => d.key))
      const max = Math.max(...dist.map((d) => d.key))
      console.log(`range: ${min}..${max}`)
      if (min === 0) console.log('>>> Contains 0 → NOT Camelot 1-24 (reader.ts treats 0 as "no key"). Likely chromatic 0-23.')
      console.log('\nNamed sample (compare the integer to each track\'s known key):')
      console.log(JSON.stringify(db.prepare('SELECT title, artist, key FROM Track WHERE key IS NOT NULL LIMIT 20').all(), null, 1))
    } catch (e) { console.log('query failed:', e.message) }
  } else if (tableExists('MetaDataInteger')) {
    console.log('No Track.key — key likely in MetaDataInteger (Mixxx docs: type=4). Value distribution by type:')
    try {
      console.log(JSON.stringify(db.prepare('SELECT type, COUNT(*) n, MIN(value) lo, MAX(value) hi FROM MetaDataInteger GROUP BY type ORDER BY type').all()))
      console.log('\nType-4 (key?) sample joined to track titles:')
      console.log(JSON.stringify(db.prepare(
        "SELECT mi.id, mi.value AS keyVal FROM MetaDataInteger mi WHERE mi.type = 4 LIMIT 20"
      ).all(), null, 1))
    } catch (e) { console.log('query failed:', e.message) }
  } else {
    console.log('Neither Track.key nor MetaDataInteger found. Key lives somewhere else; see table list above.')
  }

  section('Done — read-only, no changes were written.')
} finally {
  db.close()
}
