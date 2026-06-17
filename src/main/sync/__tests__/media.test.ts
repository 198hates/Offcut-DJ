import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { applySchema } from '../../library/schema'
import { quantize, parseRange, getPeaks, getProxyPath, type PeaksData } from '../media'

describe('quantize', () => {
  it('maps 0..1 to 0..255 and clamps out-of-range', () => {
    expect(quantize(new Float32Array([0, 0.5, 1]))).toEqual([0, 128, 255])
    expect(quantize(new Float32Array([-1, 2]))).toEqual([0, 255])
  })
})

describe('parseRange', () => {
  it('parses a closed range', () => {
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
  })
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
  })
  it('parses a suffix range', () => {
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  })
  it('clamps end to the last byte', () => {
    expect(parseRange('bytes=0-100', 10)).toEqual({ start: 0, end: 9 })
  })
  it('returns null for absent/invalid/unsatisfiable ranges', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('weird', 10)).toBeNull()
    expect(parseRange('bytes=5-2', 10)).toBeNull() // start > end
    expect(parseRange('bytes=20-', 10)).toBeNull() // start past EOF
  })
})

describe('media cache resolution', () => {
  let dir: string
  let cache: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offcut-media-'))
    cache = join(dir, 'cache')
    mkdirSync(cache, { recursive: true })
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchema(db)
  })

  function insertTrack(id: string, hash: string | null, filePath: string): void {
    db.prepare(
      "INSERT INTO tracks (id, file_path, content_hash, duration_seconds, date_added) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(id, filePath, hash, 180)
  }

  it('returns null for an unknown track', async () => {
    expect(await getPeaks(db, cache, 'ghost')).toBeNull()
    expect(await getProxyPath(db, cache, 'ghost')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves cached peaks keyed by content hash without re-decoding', async () => {
    insertTrack('t1', 'hashA', join(dir, 'does-not-exist.mp3'))
    const cached: PeaksData = {
      v: 1,
      trackId: 't1',
      contentHash: 'hashA',
      buckets: 3,
      durationSec: 180,
      peaks: [1, 2, 3],
      low: [],
      mid: [],
      high: []
    }
    writeFileSync(join(cache, 'hashA.peaks.json'), JSON.stringify(cached))
    // The source file is missing, so a cache miss would fail — a hit must win.
    expect(await getPeaks(db, cache, 't1')).toEqual(cached)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an existing proxy without transcoding', async () => {
    insertTrack('t2', 'hashB', join(dir, 'missing.flac'))
    const proxy = join(cache, 'hashB.m4a')
    writeFileSync(proxy, Buffer.from('audio'))
    expect(await getProxyPath(db, cache, 't2')).toBe(proxy)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when neither a cached proxy nor the source exists', async () => {
    insertTrack('t3', 'hashC', join(dir, 'nope.wav'))
    expect(await getProxyPath(db, cache, 't3')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})
