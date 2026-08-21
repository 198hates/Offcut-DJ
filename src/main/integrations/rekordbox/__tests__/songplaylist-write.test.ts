/**
 * Exercising the djmdSongPlaylist write against a rekordbox-SHAPED table.
 *
 * The real master.db is SQLCipher-encrypted and openRekordboxDb owns the handle,
 * so exportToRekordboxDb cannot be handed a test database. That leaves the single
 * riskiest statement in the export — the only INSERT it has ever made into a
 * playlist table — verified by reading alone. This closes that: a plain SQLite
 * database with rekordbox's column shape, foreign keys ON, built from the same
 * planSongPlaylistInsert plan the export uses.
 *
 * It cannot prove the column set matches every rekordbox version. It does prove
 * the statement is well-formed, that it satisfies NOT NULL and foreign-key
 * constraints, that re-running it is a no-op, and that the soft-delete filters
 * the import relies on actually exclude retired rows.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { planSongPlaylistInsert, planPlaylistWriteback, type ColumnInfo, type PlaylistEntry } from '../playlist-writeback'
import { rbTimestamp, newCueId } from '../cue-format'

/** rekordbox's shape for the three tables this touches, as far as it matters. */
const SCHEMA = `
  CREATE TABLE djmdPlaylist (
    ID VARCHAR(255) PRIMARY KEY,
    Name VARCHAR(255),
    rb_local_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE djmdContent (
    ID VARCHAR(255) PRIMARY KEY,
    Title VARCHAR(255),
    FolderPath VARCHAR(255),
    FileNameL VARCHAR(255),
    FileSize INTEGER,
    BPM INTEGER,
    Rating INTEGER,
    Commnt TEXT,
    rb_local_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE djmdSongPlaylist (
    ID VARCHAR(255) NOT NULL PRIMARY KEY,
    PlaylistID VARCHAR(255) REFERENCES djmdPlaylist(ID),
    ContentID VARCHAR(255) REFERENCES djmdContent(ID),
    TrackNo INTEGER,
    UUID VARCHAR(255),
    rb_data_status INTEGER NOT NULL DEFAULT 0,
    rb_local_data_status INTEGER NOT NULL DEFAULT 0,
    rb_local_deleted INTEGER NOT NULL DEFAULT 0,
    rb_local_synced INTEGER NOT NULL DEFAULT 0,
    usn INTEGER,
    rb_local_usn INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (PlaylistID, ContentID)
  );
`

/** The value map the export declares, kept in step with db-reader.ts. */
const VALUES: Record<string, (e: PlaylistEntry) => unknown> = {
  ID: () => newCueId(),
  PlaylistID: (e) => e.playlistId,
  ContentID: (e) => e.contentId,
  TrackNo: (e) => Math.max(0, Math.round(e.trackNo)),
  UUID: () => randomUUID(),
  created_at: () => rbTimestamp(),
  updated_at: () => rbTimestamp()
}

let db: Database.Database

function columnsOf(table: string): ColumnInfo[] {
  return db.prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info('${table}')`).all() as ColumnInfo[]
}

/** Exactly what the export does, minus the SqlCipher handle. */
function writeback(entries: PlaylistEntry[]): { added: number; blockedBy: string[] } {
  const plan = planSongPlaylistInsert(columnsOf('djmdSongPlaylist'), Object.keys(VALUES))
  if (plan.blockedBy.length) return { added: 0, blockedBy: plan.blockedBy }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO djmdSongPlaylist (${plan.columns.join(', ')})
     VALUES (${plan.columns.map(() => '?').join(', ')})`
  )
  let added = 0
  const run = db.transaction((es: PlaylistEntry[]) => {
    for (const e of es) {
      if (insert.run(...plan.columns.map((c) => VALUES[c](e))).changes > 0) added++
    }
  })
  run(entries)
  return { added, blockedBy: [] }
}

/** Every pair rekordbox holds, retired or not — what collision-avoidance uses. */
const allEntries = (): { playlistId: string; contentId: string }[] =>
  (db.prepare('SELECT PlaylistID, ContentID FROM djmdSongPlaylist').all() as {
    PlaylistID: string
    ContentID: string
  }[]).map((r) => ({ playlistId: String(r.PlaylistID), contentId: String(r.ContentID) }))

const liveEntries = (): { playlistId: string; contentId: string }[] =>
  (db
    .prepare(
      `SELECT PlaylistID, ContentID FROM djmdSongPlaylist WHERE COALESCE(rb_local_deleted, 0) = 0`
    )
    .all() as { PlaylistID: string; ContentID: string }[]).map((r) => ({
    playlistId: String(r.PlaylistID),
    contentId: String(r.ContentID)
  }))

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  db.exec(`
    INSERT INTO djmdPlaylist (ID, Name) VALUES ('p1','Peak Time'), ('p2','Warmup');
    INSERT INTO djmdContent (ID, Title, FolderPath, FileSize)
      VALUES ('c-old','Song','/Music/old.mp3',1000), ('c-keep','Song','/Music/keep.mp3',1000);
    INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, UUID, created_at, updated_at)
      VALUES ('1','p1','c-old',3,'u1','2026-01-01 00:00:00.000 +00:00','2026-01-01 00:00:00.000 +00:00');
  `)
})

describe('djmdSongPlaylist writeback', () => {
  it('inserts the kept copy alongside the row it replaces', () => {
    const pending = planPlaylistWriteback([{ playlistId: 'p1', contentId: 'c-keep', trackNo: 3 }], allEntries())
    expect(writeback(pending)).toEqual({ added: 1, blockedBy: [] })

    const rows = db
      .prepare('SELECT ContentID, TrackNo FROM djmdSongPlaylist WHERE PlaylistID = ? ORDER BY ContentID')
      .all('p1') as { ContentID: string; TrackNo: number }[]
    expect(rows).toEqual([
      { ContentID: 'c-keep', TrackNo: 3 },
      { ContentID: 'c-old', TrackNo: 3 }
    ])
  })

  it('satisfies every NOT NULL column — the djmdCue failure mode', () => {
    expect(() => writeback([{ playlistId: 'p2', contentId: 'c-keep', trackNo: 1 }])).not.toThrow()
    const row = db.prepare('SELECT * FROM djmdSongPlaylist WHERE PlaylistID = ?').get('p2') as Record<string, unknown>
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
    expect(row.ID).toBeTruthy()
    // Bookkeeping columns took rekordbox's own defaults rather than our guesses.
    expect(row.rb_local_deleted).toBe(0)
    expect(row.rb_data_status).toBe(0)
    expect(row.usn).toBeNull()
  })

  it('is idempotent — a second sync adds nothing and cannot break the unique key', () => {
    const wanted = [{ playlistId: 'p1', contentId: 'c-keep', trackNo: 3 }]
    writeback(planPlaylistWriteback(wanted, allEntries()))
    const second = planPlaylistWriteback(wanted, allEntries())
    expect(second).toEqual([])
    expect(writeback(second).added).toBe(0)
    const count = db.prepare('SELECT COUNT(*) AS c FROM djmdSongPlaylist').get() as { c: number }
    expect(count.c).toBe(2)
  })

  it('rolls the whole batch back if any entry violates a foreign key', () => {
    // 'ghost' is not in djmdContent — an id that went stale since the import.
    // OR IGNORE does not cover a foreign-key failure, so this still aborts; the
    // export filters against djmdContent/djmdPlaylist first so it cannot happen,
    // and this pins the blast radius if one ever slips through: all or nothing,
    // never a half-written playlist.
    expect(() =>
      writeback([
        { playlistId: 'p2', contentId: 'c-keep', trackNo: 1 },
        { playlistId: 'p2', contentId: 'ghost', trackNo: 2 }
      ])
    ).toThrow()
    const count = db.prepare('SELECT COUNT(*) AS c FROM djmdSongPlaylist WHERE PlaylistID = ?').get('p2') as { c: number }
    expect(count.c).toBe(0)
  })

  it('leaves a soft-deleted entry alone instead of colliding with it', () => {
    /* The regression this guards. A track removed from a playlist IN REKORDBOX
       leaves a retired row that still occupies the unique key, while Offcut
       still lists it — so it looks like a missing entry to push. Planning
       against live rows only produced an INSERT that collided and, inside one
       transaction, rolled back every other playlist entry in the batch. */
    db.prepare('UPDATE djmdSongPlaylist SET rb_local_deleted = 1 WHERE ContentID = ?').run('c-old')
    expect(liveEntries()).toEqual([])

    const wanted = [
      { playlistId: 'p1', contentId: 'c-old', trackNo: 3 },
      { playlistId: 'p2', contentId: 'c-keep', trackNo: 1 }
    ]
    // Planned against every pair, retired ones included: the retired one is skipped.
    const pending = planPlaylistWriteback(wanted, allEntries())
    expect(pending).toEqual([{ playlistId: 'p2', contentId: 'c-keep', trackNo: 1 }])

    // And the unrelated entry still lands, rather than dying with it.
    expect(writeback(pending)).toEqual({ added: 1, blockedBy: [] })
    expect(liveEntries()).toEqual([{ playlistId: 'p2', contentId: 'c-keep' }])
    const retired = db
      .prepare('SELECT rb_local_deleted FROM djmdSongPlaylist WHERE ContentID = ?')
      .get('c-old') as { rb_local_deleted: number }
    expect(retired.rb_local_deleted).toBe(1)
  })

  it('skips rather than aborts if an unforeseen unique constraint collides', () => {
    // Belt and braces for the OR IGNORE: planning missed it, the batch survives.
    const dup = [{ playlistId: 'p1', contentId: 'c-old', trackNo: 3 }]
    expect(writeback(dup)).toEqual({ added: 0, blockedBy: [] })
    const count = db.prepare('SELECT COUNT(*) AS c FROM djmdSongPlaylist').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('skips the write when the table demands a column we cannot fill', () => {
    db.exec('ALTER TABLE djmdSongPlaylist ADD COLUMN FutureRequired TEXT NOT NULL DEFAULT ""')
    // A DEFAULT is fine…
    expect(writeback([{ playlistId: 'p2', contentId: 'c-keep', trackNo: 1 }]).blockedBy).toEqual([])
    // …but a bare NOT NULL is not, and must be reported rather than guessed at.
    db.exec('CREATE TABLE probe (a TEXT NOT NULL)')
    const plan = planSongPlaylistInsert(columnsOf('probe'), Object.keys(VALUES))
    expect(plan.blockedBy).toEqual(['a'])
  })
})

describe('soft-delete filters the import relies on', () => {
  it('excludes a retired content row and its playlist entry', () => {
    db.prepare('UPDATE djmdContent SET rb_local_deleted = 1 WHERE ID = ?').run('c-old')
    db.prepare('UPDATE djmdSongPlaylist SET rb_local_deleted = 1 WHERE ContentID = ?').run('c-old')

    const tracks = db
      .prepare(
        `SELECT ID FROM djmdContent
         WHERE FolderPath IS NOT NULL AND FolderPath != '' AND COALESCE(rb_local_deleted, 0) = 0`
      )
      .all() as { ID: string }[]
    expect(tracks.map((t) => t.ID)).toEqual(['c-keep'])
    expect(liveEntries()).toEqual([])
  })

  it('treats a NULL flag as not deleted, so an older database still imports', () => {
    db.exec('CREATE TABLE legacy (ID TEXT, rb_local_deleted INTEGER)')
    db.exec("INSERT INTO legacy VALUES ('a', NULL), ('b', 0), ('c', 1)")
    const rows = db
      .prepare('SELECT ID FROM legacy WHERE COALESCE(rb_local_deleted, 0) = 0 ORDER BY ID')
      .all() as { ID: string }[]
    expect(rows.map((r) => r.ID)).toEqual(['a', 'b'])
  })
})


/**
 * The djmdContent guards: BPM, Rating and Commnt fill a blank but never replace
 * a value. Same SQL as exportToRekordboxDb's updateTrack, against the same fake
 * schema — the export owns its SqlCipher handle, so this is the closest a test
 * can get to the statement that touches someone's ratings.
 */
const GUARDED_UPDATE = `
  UPDATE djmdContent SET
    Title = CASE WHEN Title IS NULL OR Title = '' THEN ? ELSE Title END,
    BPM = CASE WHEN BPM IS NULL OR BPM = 0 THEN ? ELSE BPM END,
    Rating = CASE WHEN Rating IS NULL OR Rating = 0 THEN ? ELSE Rating END,
    Commnt = CASE WHEN Commnt IS NULL OR Commnt = '' THEN ? ELSE Commnt END,
    FolderPath = ?,
    FileNameL = ?
  WHERE ID = ?
`

interface Push { title: string; bpm: number | null; rating: number; comment: string }

const push = (id: string, p: Push): void => {
  db.prepare(GUARDED_UPDATE).run(p.title, p.bpm, p.rating, p.comment, `/Music/${id}.mp3`, `${id}.mp3`, id)
}

const content = (id: string): { Rating: number | null; Commnt: string | null; BPM: number | null; Title: string } =>
  db.prepare('SELECT Rating, Commnt, BPM, Title FROM djmdContent WHERE ID = ?').get(id) as never

describe('djmdContent user-field guards', () => {
  beforeEach(() => {
    db.prepare("UPDATE djmdContent SET Rating = 80, Commnt = 'set in rekordbox', BPM = 12800 WHERE ID = 'c-keep'").run()
  })

  it('keeps a rating the user set in rekordbox', () => {
    // The regression: Offcut's older 3-star value used to overwrite this.
    push('c-keep', { title: 'Song', bpm: 13000, rating: 60, comment: '' })
    expect(content('c-keep').Rating).toBe(80)
  })

  it('keeps a comment the user set in rekordbox', () => {
    push('c-keep', { title: 'Song', bpm: null, rating: 0, comment: 'offcut note' })
    expect(content('c-keep').Commnt).toBe('set in rekordbox')
  })

  it('never wipes a rekordbox rating or comment with an empty Offcut one', () => {
    // The worst case: Offcut has neither, and used to push 0 and '' over both.
    push('c-keep', { title: 'Song', bpm: null, rating: 0, comment: '' })
    const row = content('c-keep')
    expect(row.Rating).toBe(80)
    expect(row.Commnt).toBe('set in rekordbox')
  })

  it('still fills a blank rating and comment', () => {
    db.prepare("UPDATE djmdContent SET Rating = 0, Commnt = '' WHERE ID = 'c-keep'").run()
    push('c-keep', { title: 'Song', bpm: null, rating: 100, comment: 'peak time' })
    const row = content('c-keep')
    expect(row.Rating).toBe(100)
    expect(row.Commnt).toBe('peak time')
  })

  it('treats NULL as blank, so a never-rated track still gets filled', () => {
    db.prepare("UPDATE djmdContent SET Rating = NULL, Commnt = NULL WHERE ID = 'c-keep'").run()
    push('c-keep', { title: 'Song', bpm: null, rating: 40, comment: 'hi' })
    const row = content('c-keep')
    expect(row.Rating).toBe(40)
    expect(row.Commnt).toBe('hi')
  })

  it('keeps a title rekordbox already has, so Offcut never renames a track there', () => {
    push('c-keep', { title: 'Renamed In Offcut', bpm: null, rating: 0, comment: '' })
    expect(content('c-keep').Title).toBe('Song')
  })

  it('still fills a blank or missing title', () => {
    db.prepare("UPDATE djmdContent SET Title = '' WHERE ID = 'c-keep'").run()
    push('c-keep', { title: 'Recovered', bpm: null, rating: 0, comment: '' })
    expect(content('c-keep').Title).toBe('Recovered')

    db.prepare("UPDATE djmdContent SET Title = NULL WHERE ID = 'c-old'").run()
    push('c-old', { title: 'From Offcut', bpm: null, rating: 0, comment: '' })
    expect(content('c-old').Title).toBe('From Offcut')
  })

  it('leaves the path unguarded — that is the relink path and must always write', () => {
    push('c-keep', { title: 'Song', bpm: null, rating: 0, comment: '' })
    const row = db.prepare('SELECT FolderPath, FileNameL FROM djmdContent WHERE ID = ?').get('c-keep') as
      { FolderPath: string; FileNameL: string }
    expect(row).toEqual({ FolderPath: '/Music/c-keep.mp3', FileNameL: 'c-keep.mp3' })
  })

  it('keeps the existing BPM, as it already did', () => {
    push('c-keep', { title: 'Song', bpm: 9090, rating: 0, comment: '' })
    expect(content('c-keep').BPM).toBe(12800)
  })
})
