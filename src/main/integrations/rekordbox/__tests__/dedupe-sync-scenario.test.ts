/**
 * The whole workflow, end to end: dedupe in Offcut, then sync to rekordbox.
 *
 * This exists because reading the code was not enough. Every unit below it
 * passed while the composition was wrong — the prune's twin heuristic could not
 * fire for real duplicates, and a keeper with no rekordbox row vanished from the
 * playlist without being counted — and the only way that showed up was assembling
 * the pieces and looking at what a DJ would actually see. Measured before the fix:
 * 3 visible playlist entries where Offcut had 2, two of them pointing at the Trash.
 *
 * A real master.db is SQLCipher and exportToRekordboxDb owns the handle, so the
 * rekordbox half is a fake of the right shape and the export's own statements are
 * mirrored here. That makes this a composition test, not a proof about the real
 * file — but composition was exactly what broke.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../../library/schema'
import { mergeDuplicateInto } from '../../../library/merge-duplicate'
import { planPlaylistWriteback } from '../playlist-writeback'
import { planOrphanPrune, type PlaylistMembership, type Replacements } from '../prune-orphans'

let app: Database.Database
let rb: Database.Database

const addTrack = (id: string, path: string, title: string, rbId: string | null): void => {
  app
    .prepare(
      `INSERT INTO tracks (id, file_path, title, artist, date_added, source_ids)
       VALUES (?, ?, ?, 'A', datetime('now'), ?)`
    )
    .run(id, path, title, rbId ? JSON.stringify({ rekordbox: rbId }) : '{}')
}

/** Resolve a duplicate exactly as the Health page does: merge, then delete. */
const resolve = (loser: string, keeper: string): void => {
  mergeDuplicateInto(app, loser, keeper)
  app.prepare('DELETE FROM tracks WHERE id = ?').run(loser)
}

/** Everything the export does with playlists, in the same order. */
function syncPlaylists(): { added: number; pruned: number; blocked: number; noRbRow: number } {
  const wanted = (
    app
      .prepare(`
        SELECT json_extract(p.source_ids, '$.rekordbox') AS playlistId,
               json_extract(t.source_ids, '$.rekordbox') AS contentId,
               pt.sort_order AS trackNo
        FROM playlist_tracks pt
        JOIN playlists p ON p.id = pt.playlist_id
        JOIN tracks    t ON t.id = pt.track_id
        WHERE json_extract(p.source_ids, '$.rekordbox') IS NOT NULL
          AND json_extract(t.source_ids, '$.rekordbox') IS NOT NULL
          AND p.is_folder = 0 AND p.is_smart = 0
      `)
      .all() as { playlistId: string; contentId: string; trackNo: number | null }[]
  ).map((r) => ({
    playlistId: String(r.playlistId),
    contentId: String(r.contentId),
    trackNo: r.trackNo ?? 0
  }))

  const noRbRow = (
    app
      .prepare(`
        SELECT COUNT(*) AS c FROM playlist_tracks pt
        JOIN playlists p ON p.id = pt.playlist_id
        JOIN tracks    t ON t.id = pt.track_id
        WHERE json_extract(p.source_ids, '$.rekordbox') IS NOT NULL
          AND json_extract(t.source_ids, '$.rekordbox') IS NULL
          AND p.is_folder = 0 AND p.is_smart = 0
      `)
      .get() as { c: number }
  ).c

  const liveRbIds = new Set(
    (
      app
        .prepare(
          `SELECT json_extract(source_ids, '$.rekordbox') AS r FROM tracks
           WHERE json_extract(source_ids, '$.rekordbox') IS NOT NULL`
        )
        .all() as { r: string }[]
    ).map((x) => String(x.r))
  )

  const asPair = (e: { PlaylistID: string; ContentID: string }): {
    playlistId: string
    contentId: string
    trackNo: number
  } => ({ playlistId: String(e.PlaylistID), contentId: String(e.ContentID), trackNo: 0 })

  const existingAny = (
    rb.prepare('SELECT PlaylistID, ContentID FROM djmdSongPlaylist').all() as {
      PlaylistID: string
      ContentID: string
    }[]
  ).map(asPair)
  const livePlaylistIds = new Set(
    (rb.prepare('SELECT ID FROM djmdPlaylist WHERE COALESCE(rb_local_deleted,0)=0').all() as { ID: string }[])
      .map((r) => String(r.ID))
  )
  const liveContentIds = new Set(
    (rb.prepare('SELECT ID FROM djmdContent WHERE COALESCE(rb_local_deleted,0)=0').all() as { ID: string }[])
      .map((r) => String(r.ID))
  )

  const placeable = planPlaylistWriteback(wanted, existingAny).filter(
    (e) => livePlaylistIds.has(e.playlistId) && liveContentIds.has(e.contentId)
  )
  let seq = 100
  for (const e of placeable) {
    rb.prepare(
      'INSERT OR IGNORE INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo) VALUES (?,?,?,?)'
    ).run(String(seq++), e.playlistId, e.contentId, e.trackNo)
  }

  // Membership read AFTER the inserts, so a replacement just placed counts.
  const membership: PlaylistMembership = new Map()
  for (const e of rb
    .prepare('SELECT PlaylistID, ContentID FROM djmdSongPlaylist WHERE COALESCE(rb_local_deleted,0)=0')
    .all() as { PlaylistID: string; ContentID: string }[]) {
    const set = membership.get(String(e.ContentID))
    if (set) set.add(String(e.PlaylistID))
    else membership.set(String(e.ContentID), new Set([String(e.PlaylistID)]))
  }

  const replacements: Replacements = new Map()
  for (const r of app
    .prepare(`
      SELECT r.removed_rb_id AS removedId,
             json_extract(t.source_ids, '$.rekordbox') AS keeperId
      FROM duplicate_replacements r
      JOIN tracks t ON t.id = r.keeper_track_id
    `)
    .all() as { removedId: string; keeperId: string | null }[]) {
    replacements.set(String(r.removedId), r.keeperId == null ? null : String(r.keeperId))
  }

  const candidates = rb
    .prepare('SELECT ID, FolderPath, Title, FileSize FROM djmdContent WHERE COALESCE(rb_local_deleted,0)=0')
    .all() as never
  const decision = planOrphanPrune(candidates, liveRbIds, replacements, membership)
  for (const id of decision.prunable) {
    rb.prepare('UPDATE djmdContent SET rb_local_deleted=1 WHERE ID=?').run(id)
    rb.prepare('UPDATE djmdSongPlaylist SET rb_local_deleted=1 WHERE ContentID=?').run(id)
  }

  return {
    added: placeable.length,
    pruned: decision.prunable.length,
    blocked: decision.blocked.length,
    noRbRow
  }
}

/** What the DJ sees in rekordbox: live entries, in order. */
const visible = (playlistId: string): string[] =>
  (
    rb
      .prepare(
        `SELECT ContentID FROM djmdSongPlaylist
         WHERE PlaylistID = ? AND COALESCE(rb_local_deleted,0) = 0
         ORDER BY TrackNo, ContentID`
      )
      .all(playlistId) as { ContentID: string }[]
  ).map((r) => String(r.ContentID))

beforeEach(() => {
  app = new Database(':memory:')
  app.pragma('foreign_keys = ON')
  applySchema(app)

  rb = new Database(':memory:')
  rb.exec(`
    CREATE TABLE djmdPlaylist (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INT DEFAULT 0);
    CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, Title TEXT, FolderPath TEXT, FileSize INT,
                              rb_local_deleted INT DEFAULT 0);
    CREATE TABLE djmdSongPlaylist (ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INT,
                                   rb_local_deleted INT DEFAULT 0, UNIQUE (PlaylistID, ContentID));
    INSERT INTO djmdPlaylist VALUES ('p1','Peak Time',0);
  `)
})

describe('dedupe in Offcut then sync to rekordbox', () => {
  it('replaces the removed copy in the playlist and retires it', () => {
    // Two encodes of one track — DIFFERENT file sizes, which is what real
    // duplicates look like and what the old twin heuristic could never match.
    rb.exec(`
      INSERT INTO djmdContent VALUES ('c-old','Song','/M/old.mp3',1000,0),
                                     ('c-keep','Song','/M/new.aiff',5000,0);
      INSERT INTO djmdSongPlaylist VALUES ('1','p1','c-old',3,0);
    `)
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    app.prepare(`INSERT INTO playlists (id,name,source_ids) VALUES ('p','Peak','{"rekordbox":"p1"}')`).run()
    app.prepare("INSERT INTO playlist_tracks (playlist_id,track_id,sort_order) VALUES ('p','L',3)").run()

    resolve('L', 'K')
    const out = syncPlaylists()

    expect(out).toEqual({ added: 1, pruned: 1, blocked: 0, noRbRow: 0 })
    // The one thing that matters: rekordbox agrees with Offcut.
    expect(visible('p1')).toEqual(['c-keep'])
    expect(visible('p1')).toHaveLength(
      (app.prepare('SELECT COUNT(*) AS c FROM playlist_tracks').get() as { c: number }).c
    )
  })

  it('records the pairing when a duplicate is resolved', () => {
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    expect(mergeDuplicateInto(app, 'L', 'K').replacementRecorded).toBe(true)
    const rowPair = app.prepare('SELECT * FROM duplicate_replacements').get() as {
      removed_rb_id: string
      keeper_track_id: string
    }
    expect(rowPair.removed_rb_id).toBe('c-old')
    expect(rowPair.keeper_track_id).toBe('K')
  })

  it('records nothing when the removed copy was never in rekordbox', () => {
    addTrack('L', '/M/old.mp3', 'Song', null)
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    expect(mergeDuplicateInto(app, 'L', 'K').replacementRecorded).toBe(false)
    expect(app.prepare('SELECT COUNT(*) AS c FROM duplicate_replacements').get()).toEqual({ c: 0 })
  })

  it('holds the old entry in place — and says so — when the keeper is not in rekordbox', () => {
    /* The silent failure this test exists for. The keeper came from a folder
       scan, so it has no rekordbox row: it cannot be added to the playlist. The
       old copy must therefore STAY, or the playlist loses the track outright,
       and the count has to surface it. */
    rb.exec(`
      INSERT INTO djmdContent VALUES ('c-old','Song','/M/old.mp3',1000,0);
      INSERT INTO djmdSongPlaylist VALUES ('1','p1','c-old',3,0);
    `)
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.flac', 'Song', null)
    app.prepare(`INSERT INTO playlists (id,name,source_ids) VALUES ('p','Peak','{"rekordbox":"p1"}')`).run()
    app.prepare("INSERT INTO playlist_tracks (playlist_id,track_id,sort_order) VALUES ('p','L',3)").run()

    resolve('L', 'K')
    const out = syncPlaylists()

    expect(out.added).toBe(0)
    expect(out.pruned).toBe(0)
    expect(out.blocked).toBe(1)
    // Counted, not silent — this is the number that tells the user what to fix.
    expect(out.noRbRow).toBe(1)
    // The track is still reachable in rekordbox, under its old row.
    expect(visible('p1')).toEqual(['c-old'])
  })

  it('does not shorten a playlist the keeper has not reached yet', () => {
    // The old copy is in two playlists; only one of them exists in Offcut, so
    // the keeper is only placed in that one. The other must keep its entry.
    rb.exec(`
      INSERT INTO djmdPlaylist VALUES ('p2','Warmup',0);
      INSERT INTO djmdContent VALUES ('c-old','Song','/M/old.mp3',1000,0),
                                     ('c-keep','Song','/M/new.aiff',5000,0);
      INSERT INTO djmdSongPlaylist VALUES ('1','p1','c-old',3,0),('2','p2','c-old',1,0);
    `)
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    app.prepare(`INSERT INTO playlists (id,name,source_ids) VALUES ('p','Peak','{"rekordbox":"p1"}')`).run()
    app.prepare("INSERT INTO playlist_tracks (playlist_id,track_id,sort_order) VALUES ('p','L',3)").run()

    resolve('L', 'K')
    const out = syncPlaylists()

    expect(out.added).toBe(1)
    expect(out.pruned).toBe(0)
    expect(out.blocked).toBe(1)
    expect(visible('p1').sort()).toEqual(['c-keep', 'c-old'])
    expect(visible('p2')).toEqual(['c-old'])
  })

  it('is idempotent — syncing twice changes nothing the second time', () => {
    rb.exec(`
      INSERT INTO djmdContent VALUES ('c-old','Song','/M/old.mp3',1000,0),
                                     ('c-keep','Song','/M/new.aiff',5000,0);
      INSERT INTO djmdSongPlaylist VALUES ('1','p1','c-old',3,0);
    `)
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    app.prepare(`INSERT INTO playlists (id,name,source_ids) VALUES ('p','Peak','{"rekordbox":"p1"}')`).run()
    app.prepare("INSERT INTO playlist_tracks (playlist_id,track_id,sort_order) VALUES ('p','L',3)").run()

    resolve('L', 'K')
    syncPlaylists()
    const second = syncPlaylists()

    expect(second).toEqual({ added: 0, pruned: 0, blocked: 0, noRbRow: 0 })
    expect(visible('p1')).toEqual(['c-keep'])
  })

  it('handles a load of playlists at once, which is the real shape of the job', () => {
    const N = 12
    for (let i = 0; i < N; i++) {
      rb.prepare('INSERT INTO djmdPlaylist VALUES (?,?,0)').run(`pl${i}`, `List ${i}`)
    }
    rb.exec(`
      INSERT INTO djmdContent VALUES ('c-old','Song','/M/old.mp3',1000,0),
                                     ('c-keep','Song','/M/new.aiff',5000,0);
    `)
    for (let i = 0; i < N; i++) {
      rb.prepare('INSERT INTO djmdSongPlaylist VALUES (?,?,?,?,0)').run(`e${i}`, `pl${i}`, 'c-old', i)
    }
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    for (let i = 0; i < N; i++) {
      app
        .prepare('INSERT INTO playlists (id,name,source_ids) VALUES (?,?,?)')
        .run(`p${i}`, `List ${i}`, JSON.stringify({ rekordbox: `pl${i}` }))
      app.prepare('INSERT INTO playlist_tracks (playlist_id,track_id,sort_order) VALUES (?,?,?)').run(`p${i}`, 'L', i)
    }

    resolve('L', 'K')
    const out = syncPlaylists()

    expect(out).toEqual({ added: N, pruned: 1, blocked: 0, noRbRow: 0 })
    for (let i = 0; i < N; i++) expect(visible(`pl${i}`)).toEqual(['c-keep'])
  })

  it('drops the pairing if the keeper is later deleted, rather than acting on it', () => {
    addTrack('L', '/M/old.mp3', 'Song', 'c-old')
    addTrack('K', '/M/new.aiff', 'Song', 'c-keep')
    resolve('L', 'K')
    expect(app.prepare('SELECT COUNT(*) AS c FROM duplicate_replacements').get()).toEqual({ c: 1 })

    app.prepare('DELETE FROM tracks WHERE id = ?').run('K')
    // ON DELETE CASCADE: a pairing pointing at a deleted keeper is not a pairing.
    expect(app.prepare('SELECT COUNT(*) AS c FROM duplicate_replacements').get()).toEqual({ c: 0 })
  })
})
