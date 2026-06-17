import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { applyPush } from '../apply-push'
import { rowToTrack } from '../db'
import { pullChanges } from '../sync'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

let n = 0
function insertTrack(db: Database.Database, updatedAt: string): string {
  const id = `t${++n}`
  db.prepare(
    "INSERT INTO tracks (id, file_path, title, date_added, updated_at) VALUES (?, ?, ?, datetime('now'), ?)"
  ).run(id, `/m/${id}.mp3`, id, updatedAt)
  return id
}

describe('applyPush — tracks', () => {
  beforeEach(() => {
    n = 0
  })

  it('applies a newer prep edit (partial patch)', () => {
    const db = freshDb()
    const id = insertTrack(db, '2026-01-01T00:00:00Z')
    const res = applyPush(db, {
      tracks: [{ id, updatedAt: '2026-02-01T00:00:00Z', rating: 5, energy: 8, tags: ['peak'] }]
    })
    expect(res.appliedTracks).toBe(1)
    const t = rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
    expect(t.rating).toBe(5)
    expect(t.energy).toBe(8)
    expect(t.tags).toEqual(['peak'])
    // Untouched fields stay default.
    expect(t.comment).toBe('')
  })

  it('preserves the desktop beatgrid when a phone patch omits it', () => {
    // The lean mirror strips grids, so the phone never sends them. A prep edit
    // (rating + hot cues) must NOT wipe the analysed grid the desktop holds.
    const db = freshDb()
    const id = insertTrack(db, '2026-01-01T00:00:00Z')
    const grid = JSON.stringify([{ position: 0, bpm: 128 }])
    const analysed = JSON.stringify({ bpm: 128, anchorMs: 0, beatPhase: 0 })
    db.prepare('UPDATE tracks SET beatgrid = ?, analysed_beatgrid = ? WHERE id = ?').run(grid, analysed, id)

    const res = applyPush(db, {
      tracks: [
        {
          id,
          updatedAt: '2026-02-01T00:00:00Z',
          rating: 4,
          cuePoints: [{ index: 0, type: 'hotcue', positionMs: 1000, color: '#e91e63', label: 'A' }]
        }
      ]
    })
    expect(res.appliedTracks).toBe(1)
    const row = db.prepare('SELECT beatgrid, analysed_beatgrid FROM tracks WHERE id = ?').get(id) as {
      beatgrid: string
      analysed_beatgrid: string
    }
    expect(row.beatgrid).toBe(grid) // untouched
    expect(row.analysed_beatgrid).toBe(analysed) // untouched
    const t = rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
    expect(t.rating).toBe(4)
    expect(t.cuePoints).toHaveLength(1)
  })

  it('skips an edit older than the desktop copy (last-writer-wins)', () => {
    const db = freshDb()
    const id = insertTrack(db, '2026-03-01T00:00:00Z')
    const res = applyPush(db, { tracks: [{ id, updatedAt: '2026-01-01T00:00:00Z', rating: 2 }] })
    expect(res.appliedTracks).toBe(0)
    expect(res.skippedTracks).toBe(1)
    const t = rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
    expect(t.rating).toBe(0)
  })

  it('matches by content hash when the id is unknown', () => {
    const db = freshDb()
    const id = insertTrack(db, '2026-01-01T00:00:00Z')
    db.prepare('UPDATE tracks SET content_hash = ? WHERE id = ?').run('abc123', id)
    const res = applyPush(db, {
      tracks: [{ id: 'phone-local-id', contentHash: 'abc123', updatedAt: '2026-02-01T00:00:00Z', mood: 0.5 }]
    })
    expect(res.appliedTracks).toBe(1)
    const t = rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>)
    expect(t.mood).toBe(0.5)
  })

  it('does not create tracks for unknown ids', () => {
    const db = freshDb()
    const res = applyPush(db, { tracks: [{ id: 'ghost', updatedAt: '2026-02-01T00:00:00Z', rating: 3 }] })
    expect(res.appliedTracks).toBe(0)
    expect(res.skippedTracks).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM tracks').get()).toEqual({ c: 0 })
  })
})

describe('applyPush — playlists', () => {
  beforeEach(() => {
    n = 0
  })

  it('creates a playlist with ordered membership', () => {
    const db = freshDb()
    const a = insertTrack(db, '2026-01-01T00:00:00Z')
    const b = insertTrack(db, '2026-01-01T00:00:00Z')
    const res = applyPush(db, {
      playlists: [{ id: 'pl-new', updatedAt: '2026-02-01T00:00:00Z', name: 'Warmup', trackIds: [b, a] }]
    })
    expect(res.appliedPlaylists).toBe(1)
    const rows = db
      .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order')
      .all('pl-new') as { track_id: string }[]
    expect(rows.map((r) => r.track_id)).toEqual([b, a])
  })

  it('drops unknown track ids from pushed membership', () => {
    const db = freshDb()
    const a = insertTrack(db, '2026-01-01T00:00:00Z')
    applyPush(db, {
      playlists: [{ id: 'pl1', updatedAt: '2026-02-01T00:00:00Z', name: 'X', trackIds: [a, 'missing'] }]
    })
    const rows = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all('pl1')
    expect(rows).toEqual([{ track_id: a }])
  })

  it('deletes a playlist (LWW-gated)', () => {
    const db = freshDb()
    db.prepare("INSERT INTO playlists (id, name, updated_at) VALUES ('pl1', 'X', '2026-01-01T00:00:00Z')").run()
    // Older delete loses.
    expect(applyPush(db, { playlists: [{ id: 'pl1', updatedAt: '2025-01-01T00:00:00Z', deleted: true }] }).appliedPlaylists).toBe(0)
    expect(db.prepare("SELECT 1 FROM playlists WHERE id = 'pl1'").get()).toBeTruthy()
    // Newer delete wins.
    expect(applyPush(db, { playlists: [{ id: 'pl1', updatedAt: '2026-06-01T00:00:00Z', deleted: true }] }).appliedPlaylists).toBe(1)
    expect(db.prepare("SELECT 1 FROM playlists WHERE id = 'pl1'").get()).toBeUndefined()
  })

  it('reports the post-apply cursor so the phone can fast-forward', () => {
    const db = freshDb()
    const id = insertTrack(db, '2026-01-01T00:00:00Z')
    const before = pullChanges(db, 0).cursor
    const res = applyPush(db, { tracks: [{ id, updatedAt: '2026-02-01T00:00:00Z', rating: 4 }] })
    expect(res.cursor).toBeGreaterThan(before)
  })
})
