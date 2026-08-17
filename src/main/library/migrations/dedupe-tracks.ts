/**
 * One-time repair: collapse duplicate track rows that share a file_path.
 *
 * Why they exist
 * --------------
 * insertOrUpdateTrack upserted with ON CONFLICT(id), but every importer mints a
 * fresh randomUUID() per track. A new UUID can never collide, so each re-import
 * appended a whole second copy of the library instead of updating it — and the
 * upsert's careful "don't clobber the user's edits" branches never ran at all.
 * Measured on a real library: 31,345 rows for 15,672 distinct paths.
 *
 * The duplicates are not free: the library list ships every row to the renderer,
 * so a doubled table doubles the object count, allocation and GC churn behind the
 * multi-minute blank window on an Intel Mac.
 *
 * It does NOT halve the bytes, though — measured, not assumed. Only one copy of
 * each path ever carried a beatgrid, and that is the copy that survives, so the
 * ~770MB of grid JSON is unchanged by this migration and the file stays ~820MB
 * (VACUUM reclaims only ~9MB, so it isn't worth the 20s). Cutting the payload
 * itself is a separate job: don't send beatgrids in the list query at all.
 *
 * This module merges each group down to one row (keeping the richest value for
 * every user-editable field), repoints playlist/history references at the
 * survivor, deletes the losers, and then adds the UNIQUE index that lets the
 * upsert key on file_path so it can never happen again.
 */
import type Database from 'better-sqlite3'

/** Columns carrying user or analysis data worth rescuing from a losing row. */
const MERGE_COLUMNS = [
  // value is "empty" when NULL or equal to this sentinel
  { col: 'comment', empty: "''" },
  { col: 'tags', empty: "'[]'" },
  { col: 'cue_points', empty: "'[]'" },
  { col: 'beatgrid', empty: "'[]'" },
  { col: 'custom_tags', empty: "'{}'" },
  { col: 'color', empty: "''" },
  { col: 'label', empty: "''" },
  { col: 'analysed_beatgrid', empty: null },
  { col: 'edit_lineage', empty: null },
  { col: 'energy', empty: null },
  { col: 'danceability', empty: null },
  { col: 'mood', empty: null },
  { col: 'gain_db', empty: null },
  { col: 'phrases', empty: null },
  { col: 'embedding', empty: null },
  { col: 'overview_peaks', empty: null },
  { col: 'content_hash', empty: null },
  { col: 'year', empty: null },
  { col: 'file_size', empty: null },
  { col: 'file_type', empty: null },
  { col: 'sample_rate', empty: null },
  { col: 'bit_depth', empty: null },
  { col: 'last_played_at', empty: null }
] as const

export interface DedupeResult {
  ran: boolean
  before: number
  after: number
  removed: number
  playlistRefsRepointed: number
  /** Milliseconds per phase — this runs once on a big library, so make it debuggable. */
  timings: Record<string, number>
}

/** True once the UNIQUE index exists, which is what makes duplicates impossible. */
function alreadyDeduped(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name='idx_tracks_file_path_unique'`)
    .get() as { ok: number } | undefined
  return !!row
}

export function dedupeTracksByFilePath(db: Database.Database): DedupeResult {
  const before = (db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c

  if (alreadyDeduped(db)) {
    return { ran: false, before, after: before, removed: 0, playlistRefsRepointed: 0, timings: {} }
  }

  let playlistRefsRepointed = 0
  const timings: Record<string, number> = {}
  const phase = <T,>(name: string, fn: () => T): T => {
    const t0 = Date.now()
    const out = fn()
    timings[name] = Date.now() - t0
    return out
  }

  const run = db.transaction(() => {
    // Survivor per path: richest row wins. Score counts populated user fields so
    // an edited copy beats a bare re-import; ties fall back to the oldest row so
    // created_at/date_added stay meaningful.
    phase('map', () => db.exec(`
      CREATE TEMP TABLE _dupe_map AS
      WITH scored AS (
        SELECT id, file_path, rowid AS rid,
               (CASE WHEN rating > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN play_count > 0 THEN 1 ELSE 0 END)
             + (CASE WHEN comment    IS NOT NULL AND comment    != ''   THEN 1 ELSE 0 END)
             + (CASE WHEN cue_points IS NOT NULL AND cue_points != '[]' THEN 1 ELSE 0 END)
             + (CASE WHEN tags       IS NOT NULL AND tags       != '[]' THEN 1 ELSE 0 END)
             + (CASE WHEN color      IS NOT NULL AND color      != ''   THEN 1 ELSE 0 END)
             + (CASE WHEN edit_lineage      IS NOT NULL THEN 1 ELSE 0 END)
             /* beatgrid / analysed_beatgrid are deliberately NOT scored: testing
                them forces SQLite to load ~770MB of overflow pages just to rank
                rows. The merge step below rescues a grid from a losing row
                regardless of who wins, so the outcome is identical either way. */
               AS score
        FROM tracks
      ),
      ranked AS (
        SELECT id, file_path, rid,
               ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY score DESC, rid ASC) AS rn
        FROM scored
      )
      SELECT l.id AS loser_id, w.id AS winner_id
      FROM ranked l
      JOIN ranked w ON w.file_path = l.file_path AND w.rn = 1
      WHERE l.rn > 1;
    `))
    phase('mapIndexes', () => {
      db.exec('CREATE INDEX _dupe_map_loser ON _dupe_map(loser_id)')
      db.exec('CREATE INDEX _dupe_map_winner ON _dupe_map(winner_id)')
    })

    // Rescue any field the survivor lacks but a loser has. Done in SQL so the
    // beatgrid blobs are never pulled through JS (that alone is ~770MB), and as
    // ONE statement rather than one per column: every write rewrites the entire
    // row including its ~16KB beatgrid, so 23 separate UPDATEs rewrote each row
    // 23 times and took ~4.8 minutes on a 31k-row library. A single pass rewrites
    // each row at most once.
    const isEmpty = (t: string, col: string, empty: string | null): string =>
      empty === null ? `${t}.${col} IS NULL` : `(${t}.${col} IS NULL OR ${t}.${col} = ${empty})`

    const assignments = MERGE_COLUMNS.map(({ col, empty }) => {
      const donor = `(SELECT t2.${col} FROM tracks t2
                      WHERE t2.file_path = tracks.file_path AND NOT (${isEmpty('t2', col, empty)})
                      ORDER BY t2.updated_at DESC, t2.rowid ASC LIMIT 1)`
      // Keep our own value when we have one; else take a donor's; else stay put
      // (several columns are NOT NULL, so a bare NULL would abort the migration).
      return `${col} = CASE WHEN NOT (${isEmpty('tracks', col, empty)}) THEN ${col}
                            ELSE COALESCE(${donor}, ${col}) END`
    })
    // Numeric fields take the group maximum rather than first-non-empty.
    assignments.push(
      `rating = MAX(rating, COALESCE((SELECT MAX(t2.rating) FROM tracks t2 WHERE t2.file_path = tracks.file_path), 0))`,
      `play_count = MAX(play_count, COALESCE((SELECT MAX(t2.play_count) FROM tracks t2 WHERE t2.file_path = tracks.file_path), 0))`
    )

    // Only touch survivors that actually need something. SQLite rewrites the
    // whole row for any UPDATE — beatgrid included — so blanket-updating all
    // 15.6k survivors cost ~78s even when nearly all were already complete
    // (exact re-import duplicates). This guard skips those rewrites entirely.
    const needsMerge = MERGE_COLUMNS.map(
      ({ col, empty }) =>
        `(${isEmpty('tracks', col, empty)} AND NOT (${isEmpty('t2', col, empty)}))`
    ).join(' OR ')

    phase('merge', () => db.exec(`
      UPDATE tracks SET ${assignments.join(',\n        ')}
      WHERE EXISTS (SELECT 1 FROM _dupe_map m WHERE m.winner_id = tracks.id)
        AND EXISTS (
          SELECT 1 FROM tracks t2
          WHERE t2.file_path = tracks.file_path AND t2.id != tracks.id
            AND (${needsMerge}
                 OR t2.rating > tracks.rating
                 OR t2.play_count > tracks.play_count)
        )
    `))

    // Repoint references BEFORE deleting: playlist_tracks cascades on delete, so
    // dropping a loser first would silently drop its playlist memberships.
    // INSERT OR IGNORE because the survivor may already be in that playlist.
    const ins = phase('playlistRepoint', () => db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order)
      SELECT pt.playlist_id, m.winner_id, pt.sort_order
      FROM playlist_tracks pt JOIN _dupe_map m ON m.loser_id = pt.track_id
    `).run())
    playlistRefsRepointed = ins.changes
    phase('playlistCleanup', () =>
      db.exec('DELETE FROM playlist_tracks WHERE track_id IN (SELECT loser_id FROM _dupe_map)'))

    phase('playHistory', () => db.exec(`
      UPDATE play_history SET track_id = (
        SELECT m.winner_id FROM _dupe_map m WHERE m.loser_id = play_history.track_id
      )
      WHERE track_id IN (SELECT loser_id FROM _dupe_map)
    `))

    phase('deleteLosers', () =>
      db.exec('DELETE FROM tracks WHERE id IN (SELECT loser_id FROM _dupe_map)'))
    db.exec('DROP TABLE _dupe_map')

    // The point of the whole exercise: make a duplicate path impossible, which
    // is also what lets the upsert switch to ON CONFLICT(file_path).
    phase('uniqueIndex', () =>
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_file_path_unique ON tracks(file_path)'))
  })

  run()

  const after = (db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c
  return { ran: true, before, after, removed: before - after, playlistRefsRepointed, timings }
}
