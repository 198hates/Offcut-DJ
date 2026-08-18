/**
 * One-time repair: merge playlist rows that re-imports duplicated.
 *
 * Same root cause as the track duplication (see dedupe-tracks): every importer
 * minted a fresh randomUUID() and then did `INSERT OR REPLACE INTO playlists`,
 * which keys on the PRIMARY KEY. A new UUID can never collide, so each re-import
 * appended a whole second set of playlists rather than updating them. Measured on
 * a real library: 389 playlists for 240 distinct names, 137 names duplicated,
 * some three times over.
 *
 * Identity is the source id, NOT the name. Importers write source_ids as
 * `{"rekordbox":"168634663"}`, and the duplicates share it exactly. Two playlists
 * a user happens to have named the same thing are a different thing entirely and
 * are deliberately left alone — merging those would destroy real work.
 */
import type Database from 'better-sqlite3'

export interface DedupePlaylistsResult {
  before: number
  after: number
  removed: number
  /** playlist_tracks rows moved onto a surviving playlist. */
  membershipMerged: number
}

export function dedupePlaylistsBySource(db: Database.Database): DedupePlaylistsResult {
  const count = (): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM playlists').get() as { c: number }).c
  const before = count()
  let membershipMerged = 0

  const run = db.transaction(() => {
    // Survivor per source id: the one carrying the most tracks (a re-import can
    // leave a half-populated copy), oldest first on a tie so the original wins.
    db.exec(`
      CREATE TEMP TABLE _pl_map AS
      WITH ranked AS (
        SELECT p.id, p.source_ids, p.rowid AS rid,
               (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS n_tracks,
               ROW_NUMBER() OVER (
                 PARTITION BY p.source_ids
                 ORDER BY (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) DESC,
                          p.rowid ASC
               ) AS rn
        FROM playlists p
        WHERE p.source_ids IS NOT NULL
          AND p.source_ids NOT IN ('', '{}')
      )
      SELECT l.id AS loser_id, w.id AS winner_id
      FROM ranked l
      JOIN ranked w ON w.source_ids = l.source_ids AND w.rn = 1
      WHERE l.rn > 1;
    `)
    db.exec('CREATE INDEX _pl_map_loser ON _pl_map(loser_id)')

    // Union the membership onto the survivor before deleting anything: the FK is
    // ON DELETE CASCADE, so dropping a loser first would silently take its tracks
    // with it. OR IGNORE because the survivor may already hold the same track.
    const ins = db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order)
      SELECT m.winner_id, pt.track_id, pt.sort_order
      FROM playlist_tracks pt JOIN _pl_map m ON m.loser_id = pt.playlist_id
    `).run()
    membershipMerged = ins.changes

    // Re-parent any folder children pointing at a losing row.
    db.exec(`
      UPDATE playlists SET parent_id = (
        SELECT m.winner_id FROM _pl_map m WHERE m.loser_id = playlists.parent_id
      )
      WHERE parent_id IN (SELECT loser_id FROM _pl_map)
    `)

    // set_sessions.playlist_id is UNIQUE, so a session can only be moved when the
    // survivor has none of its own; the rest go with their playlist. A played-set
    // record is history — better to drop the duplicate than to fail the merge.
    db.exec(`
      UPDATE set_sessions SET playlist_id = (
        SELECT m.winner_id FROM _pl_map m WHERE m.loser_id = set_sessions.playlist_id
      )
      WHERE playlist_id IN (SELECT loser_id FROM _pl_map)
        AND NOT EXISTS (
          SELECT 1 FROM set_sessions s2
          WHERE s2.playlist_id = (SELECT m.winner_id FROM _pl_map m WHERE m.loser_id = set_sessions.playlist_id)
        )
    `)

    db.exec('DELETE FROM playlists WHERE id IN (SELECT loser_id FROM _pl_map)')
    db.exec('DROP TABLE _pl_map')
  })

  run()
  const after = count()
  return { before, after, removed: before - after, membershipMerged }
}

/**
 * The id an importer should write for a playlist from `integration` with the
 * external id `externalId` — the existing row's id when we've seen it before, so
 * `INSERT OR REPLACE` actually replaces instead of inserting a duplicate.
 * Returns null when it's new and the caller should mint an id.
 */
export function findPlaylistIdBySource(
  db: Database.Database,
  integration: string,
  externalId: string
): string | null {
  const row = db
    .prepare(`SELECT id FROM playlists WHERE json_extract(source_ids, '$.' || ?) = ? LIMIT 1`)
    .get(integration, String(externalId)) as { id: string } | undefined
  return row?.id ?? null
}
