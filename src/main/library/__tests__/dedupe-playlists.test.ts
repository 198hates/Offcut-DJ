import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { dedupePlaylistsBySource, findPlaylistIdBySource } from '../migrations/dedupe-playlists'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

let db: Database.Database
let seq = 0
beforeEach(() => { db = freshDb(); seq = 0 })

function playlist(id: string, name: string, source: object | null): void {
  db.prepare('INSERT INTO playlists (id, name, sort_order, source_ids) VALUES (?,?,?,?)')
    .run(id, name, seq++, source ? JSON.stringify(source) : '{}')
}
function track(id: string): void {
  db.prepare("INSERT INTO tracks (id, file_path, title, date_added) VALUES (?,?,?,datetime('now'))")
    .run(id, `/m/${id}.mp3`, id)
}
function member(pl: string, tr: string, order = 0): void {
  db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run(pl, tr, order)
}
const memberships = (pl: string): string[] =>
  (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY track_id').all(pl) as { track_id: string }[])
    .map((r) => r.track_id)

describe('dedupePlaylistsBySource', () => {
  it('merges playlists that share a source id', () => {
    playlist('a', 'House', { rekordbox: '111' })
    playlist('b', 'House', { rekordbox: '111' })
    playlist('c', 'Techno', { rekordbox: '222' })

    const res = dedupePlaylistsBySource(db)

    expect(res.before).toBe(3)
    expect(res.after).toBe(2)
    expect(res.removed).toBe(1)
  })

  it('NEVER merges same-named playlists that have no source id', () => {
    // Two hand-made playlists a user happens to have named the same thing.
    playlist('a', 'Favourites', null)
    playlist('b', 'Favourites', null)

    const res = dedupePlaylistsBySource(db)

    expect(res.removed).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM playlists').get() as { c: number }).c).toBe(2)
  })

  it('does not merge different source ids that share a name', () => {
    playlist('a', 'House', { rekordbox: '111' })
    playlist('b', 'House', { rekordbox: '999' })

    expect(dedupePlaylistsBySource(db).removed).toBe(0)
  })

  it('keeps the copy with the most tracks as the survivor', () => {
    playlist('thin', 'House', { rekordbox: '111' })
    playlist('fat', 'House', { rekordbox: '111' })
    track('t1'); track('t2'); track('t3')
    member('thin', 't1')
    member('fat', 't1'); member('fat', 't2'); member('fat', 't3')

    dedupePlaylistsBySource(db)

    const rows = db.prepare('SELECT id FROM playlists').all() as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual(['fat'])
  })

  it('unions membership rather than losing the loser\'s tracks', () => {
    playlist('w', 'House', { rekordbox: '111' })
    playlist('l', 'House', { rekordbox: '111' })
    track('t1'); track('t2'); track('t3')
    member('w', 't1'); member('w', 't2')
    member('l', 't2'); member('l', 't3') // t3 exists ONLY on the loser

    const res = dedupePlaylistsBySource(db)

    expect(memberships('w')).toEqual(['t1', 't2', 't3'])
    expect(res.membershipMerged).toBe(1) // only t3 was new
  })

  it('re-parents folder children of a removed duplicate', () => {
    playlist('w', 'Folder', { rekordbox: '111' })
    playlist('l', 'Folder', { rekordbox: '111' })
    playlist('child', 'Child', { rekordbox: '222' })
    db.prepare("UPDATE playlists SET parent_id = 'l' WHERE id = 'child'").run()

    dedupePlaylistsBySource(db)

    const row = db.prepare("SELECT parent_id FROM playlists WHERE id = 'child'").get() as { parent_id: string }
    expect(row.parent_id).toBe('w')
  })

  it('is idempotent', () => {
    playlist('a', 'House', { rekordbox: '111' })
    playlist('b', 'House', { rekordbox: '111' })
    dedupePlaylistsBySource(db)

    expect(dedupePlaylistsBySource(db).removed).toBe(0)
  })

  it('collapses three copies to one', () => {
    playlist('a', 'House', { rekordbox: '111' })
    playlist('b', 'House', { rekordbox: '111' })
    playlist('c', 'House', { rekordbox: '111' })

    expect(dedupePlaylistsBySource(db).after).toBe(1)
  })
})

describe('findPlaylistIdBySource', () => {
  it('returns the existing id so a re-import updates instead of duplicating', () => {
    playlist('existing', 'House', { rekordbox: '111' })

    expect(findPlaylistIdBySource(db, 'rekordbox', '111')).toBe('existing')
  })

  it('returns null for an unseen playlist', () => {
    playlist('existing', 'House', { rekordbox: '111' })

    expect(findPlaylistIdBySource(db, 'rekordbox', '222')).toBeNull()
    expect(findPlaylistIdBySource(db, 'serato', '111')).toBeNull()
  })
})
