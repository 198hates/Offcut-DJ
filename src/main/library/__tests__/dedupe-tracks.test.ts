import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { dedupeTracksByFilePath } from '../migrations/dedupe-tracks'

/**
 * A database in the state this migration exists to repair: the schema as it was
 * BEFORE file_path was unique, so duplicate rows can still be created. applySchema
 * now adds that index up front, which is why it has to be dropped here — on a
 * legacy library it could not be created until the duplicates were gone.
 */
function legacyDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  db.exec('DROP INDEX IF EXISTS idx_tracks_file_path_unique')
  return db
}

interface TrackSeed {
  id: string
  path: string
  rating?: number
  playCount?: number
  comment?: string
  cues?: string
  beatgrid?: string
  color?: string
  energy?: number
  updatedAt?: string
}

function insert(db: Database.Database, t: TrackSeed): void {
  db.prepare(
    `INSERT INTO tracks (id, file_path, title, date_added, rating, play_count, comment,
       cue_points, beatgrid, color, energy, updated_at)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id, t.path, t.id, t.rating ?? 0, t.playCount ?? 0, t.comment ?? '',
    t.cues ?? '[]', t.beatgrid ?? '[]', t.color ?? '', t.energy ?? null,
    t.updatedAt ?? '2026-01-01 00:00:00'
  )
}

let db: Database.Database
beforeEach(() => { db = legacyDb() })

describe('dedupeTracksByFilePath', () => {
  it('collapses duplicates down to one row per path', () => {
    insert(db, { id: 'a1', path: '/m/one.mp3' })
    insert(db, { id: 'a2', path: '/m/one.mp3' })
    insert(db, { id: 'b1', path: '/m/two.mp3' })

    const res = dedupeTracksByFilePath(db)

    expect(res.ran).toBe(true)
    expect(res.before).toBe(3)
    expect(res.after).toBe(2)
    expect(res.removed).toBe(1)
    const paths = db.prepare('SELECT file_path FROM tracks ORDER BY file_path').all()
    expect(paths).toEqual([{ file_path: '/m/one.mp3' }, { file_path: '/m/two.mp3' }])
  })

  it('keeps the richest row as the survivor', () => {
    // The bare row is inserted first, so a naive "keep the oldest" would lose the edits.
    insert(db, { id: 'bare', path: '/m/x.mp3' })
    insert(db, { id: 'rich', path: '/m/x.mp3', rating: 5, comment: 'gold', cues: '[{"ms":1}]' })

    dedupeTracksByFilePath(db)

    const row = db.prepare('SELECT id, rating, comment FROM tracks').get() as Record<string, unknown>
    expect(row.id).toBe('rich')
    expect(row.rating).toBe(5)
    expect(row.comment).toBe('gold')
  })

  it('rescues fields that only a losing row had', () => {
    // Edits are split across copies: neither row alone is complete.
    insert(db, { id: 'w', path: '/m/x.mp3', rating: 4, comment: 'keep me' })
    insert(db, { id: 'l', path: '/m/x.mp3', cues: '[{"ms":42}]', color: '#ff0000', energy: 7 })

    dedupeTracksByFilePath(db)

    const row = db.prepare('SELECT * FROM tracks').get() as Record<string, unknown>
    expect(row.id).toBe('w')
    expect(row.comment).toBe('keep me')
    expect(row.cue_points).toBe('[{"ms":42}]') // came from the loser
    expect(row.color).toBe('#ff0000')
    expect(row.energy).toBe(7)
  })

  it('takes the maximum rating and play_count across the group', () => {
    insert(db, { id: 'a', path: '/m/x.mp3', rating: 2, playCount: 10, comment: 'x' })
    insert(db, { id: 'b', path: '/m/x.mp3', rating: 5, playCount: 3 })

    dedupeTracksByFilePath(db)

    const row = db.prepare('SELECT rating, play_count FROM tracks').get() as Record<string, unknown>
    expect(row.rating).toBe(5)
    expect(row.play_count).toBe(10)
  })

  it('repoints playlist membership at the survivor instead of dropping it', () => {
    insert(db, { id: 'w', path: '/m/x.mp3', rating: 5 })
    insert(db, { id: 'l', path: '/m/x.mp3' })
    db.prepare("INSERT INTO playlists (id, name) VALUES ('p1', 'Set')").run()
    // Only the LOSER is in the playlist — a plain delete would cascade it away.
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p1', 'l', 0)

    dedupeTracksByFilePath(db)

    const rows = db.prepare('SELECT track_id FROM playlist_tracks').all()
    expect(rows).toEqual([{ track_id: 'w' }])
  })

  it('does not duplicate membership when both copies are in the same playlist', () => {
    insert(db, { id: 'w', path: '/m/x.mp3', rating: 5 })
    insert(db, { id: 'l', path: '/m/x.mp3' })
    db.prepare("INSERT INTO playlists (id, name) VALUES ('p1', 'Set')").run()
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p1', 'w', 0)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p1', 'l', 1)

    dedupeTracksByFilePath(db)

    const rows = db.prepare('SELECT track_id FROM playlist_tracks').all()
    expect(rows).toEqual([{ track_id: 'w' }])
  })

  it('repoints play_history at the survivor', () => {
    insert(db, { id: 'w', path: '/m/x.mp3', rating: 5 })
    insert(db, { id: 'l', path: '/m/x.mp3' })
    db.prepare("INSERT INTO play_history (id, track_id) VALUES ('h1', 'l')").run()

    dedupeTracksByFilePath(db)

    expect(db.prepare('SELECT track_id FROM play_history').all()).toEqual([{ track_id: 'w' }])
  })

  it('adds the unique index so duplicates cannot come back', () => {
    insert(db, { id: 'a', path: '/m/x.mp3' })
    insert(db, { id: 'b', path: '/m/x.mp3' })

    dedupeTracksByFilePath(db)

    expect(() =>
      db.prepare("INSERT INTO tracks (id, file_path, title, date_added) VALUES ('c','/m/x.mp3','c',datetime('now'))").run()
    ).toThrow(/UNIQUE/i)
  })

  it('is a no-op on a second run', () => {
    insert(db, { id: 'a', path: '/m/x.mp3' })
    insert(db, { id: 'b', path: '/m/x.mp3' })
    dedupeTracksByFilePath(db)

    const second = dedupeTracksByFilePath(db)

    expect(second.ran).toBe(false)
    expect(second.removed).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c).toBe(1)
  })

  it('leaves an already-clean library untouched', () => {
    insert(db, { id: 'a', path: '/m/one.mp3', rating: 3 })
    insert(db, { id: 'b', path: '/m/two.mp3' })

    const res = dedupeTracksByFilePath(db)

    expect(res.removed).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c).toBe(2)
    expect((db.prepare("SELECT rating FROM tracks WHERE id='a'").get() as { rating: number }).rating).toBe(3)
  })

  it('handles a group of more than two copies', () => {
    insert(db, { id: 'a', path: '/m/x.mp3' })
    insert(db, { id: 'b', path: '/m/x.mp3', rating: 4 })
    insert(db, { id: 'c', path: '/m/x.mp3', comment: 'note' })
    insert(db, { id: 'd', path: '/m/x.mp3' })

    const res = dedupeTracksByFilePath(db)

    expect(res.after).toBe(1)
    const row = db.prepare('SELECT rating, comment FROM tracks').get() as Record<string, unknown>
    expect(row.rating).toBe(4)
    expect(row.comment).toBe('note') // rescued from a different copy
  })
})
