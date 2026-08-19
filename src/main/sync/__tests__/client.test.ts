import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../library/schema'
import { applyPulled, buildPushPayload } from '../client'
import { pullChanges, getSyncCursor, getChangesSince } from '../../library/sync'
import { applyPush } from '../../library/apply-push'
import type { SyncPull } from '../../../shared/types'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

/** A host database with some real content to serve. */
function hostDb(): Database.Database {
  const db = freshDb()
  for (const [id, title] of [['t1', 'One'], ['t2', 'Two'], ['t3', 'Three']]) {
    db.prepare(
      `INSERT INTO tracks (id, file_path, title, artist, date_added, rating, updated_at)
       VALUES (?, ?, ?, 'A', datetime('now'), 0, '2026-01-01T00:00:00Z')`
    ).run(id, `/m/${id}.mp3`, title)
  }
  // Explicit old timestamp: applyPush is last-writer-wins, so a row created
  // with datetime('now') would out-rank any patch a test can construct.
  db.prepare(
    "INSERT INTO playlists (id, name, sort_order, updated_at) VALUES ('p1', 'Set One', 0, '2026-01-01T00:00:00Z')"
  ).run()
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES ('p1','t1',0)").run()
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES ('p1','t2',1)").run()
  return db
}

let host: Database.Database
let client: Database.Database
beforeEach(() => { host = hostDb(); client = freshDb() })

const snapshot = (db: Database.Database, cursor = 0): SyncPull => pullChanges(db, cursor)

describe('sync client — pull', () => {
  it('mirrors the host library into an empty client', () => {
    const res = applyPulled(client, snapshot(host))

    expect(res.tracks).toBe(3)
    expect(res.playlists).toBe(1)
    expect((client.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c).toBe(3)
    const members = client.prepare(
      "SELECT track_id FROM playlist_tracks WHERE playlist_id='p1' ORDER BY sort_order"
    ).all()
    expect(members).toEqual([{ track_id: 't1' }, { track_id: 't2' }])
  })

  it('is idempotent — pulling the same snapshot twice changes nothing', () => {
    applyPulled(client, snapshot(host))
    applyPulled(client, snapshot(host))

    expect((client.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c).toBe(3)
    expect((client.prepare('SELECT COUNT(*) AS c FROM playlist_tracks').get() as { c: number }).c).toBe(2)
  })

  it('mirrors membership removals rather than merging them', () => {
    applyPulled(client, snapshot(host))
    // Host removes t2 from the playlist.
    host.prepare("DELETE FROM playlist_tracks WHERE playlist_id='p1' AND track_id='t2'").run()

    applyPulled(client, snapshot(host))

    const members = client.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id='p1'").all()
    expect(members).toEqual([{ track_id: 't1' }])
  })

  it('does not write grids — the host strips them and empty is not truth', () => {
    applyPulled(client, snapshot(host))
    // Client happens to hold a grid for t1 (e.g. pulled once when it had one).
    client.prepare("INSERT INTO track_grids (track_id, beatgrid) VALUES ('t1', '[{\"positionMs\":0}]')").run()

    applyPulled(client, snapshot(host))

    const g = client.prepare("SELECT beatgrid FROM track_grids WHERE track_id='t1'").get() as
      | { beatgrid: string } | undefined
    expect(g?.beatgrid).toBe('[{"positionMs":0}]') // survived the pull
  })

  it('applies deletions from the host', () => {
    applyPulled(client, snapshot(host))
    const cursor = getSyncCursor(host)
    host.prepare("DELETE FROM tracks WHERE id='t3'").run()

    const res = applyPulled(client, snapshot(host, cursor))

    expect(res.deletedTracks).toBe(1)
    expect(client.prepare("SELECT 1 FROM tracks WHERE id='t3'").get()).toBeUndefined()
  })
})

describe('sync client — push', () => {
  it('sends a local playlist edit back to the host', () => {
    applyPulled(client, snapshot(host))
    const pushCursor = getSyncCursor(client)

    // Edit on the client: rename and drop a track.
    client.prepare("UPDATE playlists SET name='Renamed', updated_at='2026-06-01T00:00:00Z' WHERE id='p1'").run()
    client.prepare("DELETE FROM playlist_tracks WHERE playlist_id='p1' AND track_id='t2'").run()

    const payload = buildPushPayload(client, getChangesSince(client, pushCursor))
    const res = applyPush(host, payload)

    expect(res.appliedPlaylists).toBeGreaterThan(0)
    const row = host.prepare("SELECT name FROM playlists WHERE id='p1'").get() as { name: string }
    expect(row.name).toBe('Renamed')
    const members = host.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id='p1'").all()
    expect(members).toEqual([{ track_id: 't1' }])
  })

  it('sends a local track metadata edit back', () => {
    applyPulled(client, snapshot(host))
    const pushCursor = getSyncCursor(client)

    client.prepare("UPDATE tracks SET rating=5, comment='banger', updated_at='2026-06-01T00:00:00Z' WHERE id='t1'").run()

    const payload = buildPushPayload(client, getChangesSince(client, pushCursor))
    applyPush(host, payload)

    const row = host.prepare("SELECT rating, comment FROM tracks WHERE id='t1'").get() as
      { rating: number; comment: string }
    expect(row.rating).toBe(5)
    expect(row.comment).toBe('banger')
  })

  it('ECHO GUARD: a fresh pull produces nothing to push', () => {
    // This is the whole reason for the two cursors. Applying a pull writes to
    // the local tables, which journals those writes. Without advancing the push
    // cursor past them, the client would send the host its own data straight back.
    applyPulled(client, snapshot(host))
    const pushCursor = getSyncCursor(client)

    const payload = buildPushPayload(client, getChangesSince(client, pushCursor))

    expect(payload.tracks ?? []).toHaveLength(0)
    expect(payload.playlists ?? []).toHaveLength(0)
  })

  it('never pushes a track deletion — the client is not authoritative for those', () => {
    applyPulled(client, snapshot(host))
    const pushCursor = getSyncCursor(client)
    client.prepare("DELETE FROM tracks WHERE id='t3'").run()

    const payload = buildPushPayload(client, getChangesSince(client, pushCursor))

    expect(payload.tracks ?? []).toHaveLength(0)
    expect(host.prepare("SELECT 1 FROM tracks WHERE id='t3'").get()).toBeTruthy()
  })

  it('does push a playlist deletion', () => {
    applyPulled(client, snapshot(host))
    const pushCursor = getSyncCursor(client)
    client.prepare("DELETE FROM playlists WHERE id='p1'").run()

    const payload = buildPushPayload(client, getChangesSince(client, pushCursor))
    applyPush(host, payload)

    expect(payload.playlists?.[0]?.deleted).toBe(true)
    expect(host.prepare("SELECT 1 FROM playlists WHERE id='p1'").get()).toBeUndefined()
  })

  it('a full round trip converges both sides', () => {
    applyPulled(client, snapshot(host))
    let pushCursor = getSyncCursor(client)

    client.prepare("UPDATE tracks SET rating=4, updated_at='2026-06-01T00:00:00Z' WHERE id='t2'").run()
    applyPush(host, buildPushPayload(client, getChangesSince(client, pushCursor)))
    pushCursor = getSyncCursor(client)

    // Host makes its own change, client pulls again.
    host.prepare("UPDATE tracks SET energy=8, updated_at='2026-07-01T00:00:00Z' WHERE id='t1'").run()
    applyPulled(client, snapshot(host))

    const c1 = client.prepare("SELECT energy FROM tracks WHERE id='t1'").get() as { energy: number }
    const h2 = host.prepare("SELECT rating FROM tracks WHERE id='t2'").get() as { rating: number }
    expect(c1.energy).toBe(8) // host change reached the client
    expect(h2.rating).toBe(4) // client change reached the host
  })
})
