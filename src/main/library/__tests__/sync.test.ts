import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { getSyncCursor, getChangesSince, pullChanges } from '../sync'
import { computeContentHash, backfillContentHashes } from '../content-hash'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

let id = 0
function insertTrack(db: Database.Database, fields: Partial<{ title: string; file_path: string }> = {}): string {
  const tid = `t${++id}`
  db.prepare("INSERT INTO tracks (id, file_path, title, date_added) VALUES (?, ?, ?, datetime('now'))").run(
    tid,
    fields.file_path ?? `/music/${tid}.mp3`,
    fields.title ?? tid
  )
  return tid
}

function insertPlaylist(db: Database.Database, name = 'pl'): string {
  const pid = `p${++id}`
  db.prepare('INSERT INTO playlists (id, name) VALUES (?, ?)').run(pid, name)
  return pid
}

describe('sync journal', () => {
  beforeEach(() => {
    id = 0
  })

  it('logs an upsert on insert and advances the cursor', () => {
    const db = freshDb()
    expect(getSyncCursor(db)).toBe(0)
    const tid = insertTrack(db)
    const cursor = getSyncCursor(db)
    expect(cursor).toBeGreaterThan(0)
    const changes = getChangesSince(db, 0)
    expect(changes).toEqual([{ entity: 'track', entityId: tid, op: 'upsert', seq: cursor }])
  })

  it('collapses multiple edits to the latest op for an entity', () => {
    const db = freshDb()
    const tid = insertTrack(db)
    db.prepare('UPDATE tracks SET title = ? WHERE id = ?').run('renamed', tid)
    db.prepare('UPDATE tracks SET rating = 5 WHERE id = ?').run(tid)
    const changes = getChangesSince(db, 0)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ entity: 'track', entityId: tid, op: 'upsert' })
  })

  it('resolves a delete-after-upsert to delete', () => {
    const db = freshDb()
    const tid = insertTrack(db)
    db.prepare('UPDATE tracks SET title = ? WHERE id = ?').run('x', tid)
    db.prepare('DELETE FROM tracks WHERE id = ?').run(tid)
    const changes = getChangesSince(db, 0)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ entity: 'track', op: 'delete' })
  })

  it('marks the owning playlist dirty when membership changes', () => {
    const db = freshDb()
    const tid = insertTrack(db)
    const pid = insertPlaylist(db)
    const after = getSyncCursor(db)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, 0)').run(pid, tid)
    const changes = getChangesSince(db, after)
    expect(changes).toEqual([{ entity: 'playlist', entityId: pid, op: 'upsert', seq: expect.any(Number) }])
  })

  it('does not resurrect a deleted playlist via its cascaded membership rows', () => {
    const db = freshDb()
    const tid = insertTrack(db)
    const pid = insertPlaylist(db)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, 0)').run(pid, tid)
    const before = getSyncCursor(db)
    db.prepare('DELETE FROM playlists WHERE id = ?').run(pid) // cascades playlist_tracks
    const changes = getChangesSince(db, before)
    const forPlaylist = changes.filter((c) => c.entity === 'playlist' && c.entityId === pid)
    expect(forPlaylist).toHaveLength(1)
    expect(forPlaylist[0].op).toBe('delete')
  })
})

describe('pullChanges', () => {
  beforeEach(() => {
    id = 0
  })

  it('returns a full snapshot from cursor 0', () => {
    const db = freshDb()
    const t1 = insertTrack(db)
    const t2 = insertTrack(db)
    const pid = insertPlaylist(db)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, 0)').run(pid, t1)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, 1)').run(pid, t2)

    const pull = pullChanges(db, 0)
    expect(pull.tracks.map((t) => t.id).sort()).toEqual([t1, t2].sort())
    expect(pull.playlists).toHaveLength(1)
    expect(pull.playlists[0].trackIds).toEqual([t1, t2])
    expect(pull.deletedTrackIds).toEqual([])
    expect(pull.cursor).toBe(getSyncCursor(db))
  })

  it('returns only deltas after a cursor, with deletions', () => {
    const db = freshDb()
    const t1 = insertTrack(db)
    insertTrack(db) // t2, untouched after the cursor
    const cursor = pullChanges(db, 0).cursor

    const t3 = insertTrack(db)
    db.prepare('UPDATE tracks SET rating = 4 WHERE id = ?').run(t1)
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t3)

    const delta = pullChanges(db, cursor)
    // t3 inserted then deleted → reported as a deletion, not an upsert.
    expect(delta.tracks.map((t) => t.id)).toEqual([t1])
    expect(delta.deletedTrackIds).toEqual([t3])
    expect(delta.cursor).toBeGreaterThan(cursor)

    // Pulling again from the new cursor yields nothing.
    const empty = pullChanges(db, delta.cursor)
    expect(empty.tracks).toEqual([])
    expect(empty.deletedTrackIds).toEqual([])
  })
})

describe('content hash', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offcut-hash-'))
    id = 0
  })

  it('is stable for identical content and differs for different content', () => {
    const a = join(dir, 'a.bin')
    const b = join(dir, 'b.bin')
    writeFileSync(a, Buffer.alloc(200_000, 7))
    writeFileSync(b, Buffer.alloc(200_000, 9))
    const ha = computeContentHash(a)
    expect(ha).toBeTruthy()
    expect(computeContentHash(a)).toBe(ha) // stable
    expect(computeContentHash(b)).not.toBe(ha)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for a missing file', () => {
    expect(computeContentHash(join(dir, 'nope.bin'))).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('backfills hashes for tracks that lack one', () => {
    const db = freshDb()
    const file = join(dir, 'song.mp3')
    writeFileSync(file, Buffer.alloc(100_000, 3))
    const tid = insertTrack(db, { file_path: file })
    insertTrack(db, { file_path: join(dir, 'missing.mp3') })

    const res = backfillContentHashes(db)
    expect(res.processed).toBe(2)
    expect(res.hashed).toBe(1) // only the file that exists

    const row = db.prepare('SELECT content_hash FROM tracks WHERE id = ?').get(tid) as { content_hash: string }
    expect(row.content_hash).toBe(computeContentHash(file))
    rmSync(dir, { recursive: true, force: true })
  })
})
