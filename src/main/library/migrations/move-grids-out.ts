/**
 * One-time: move `beatgrid` / `analysed_beatgrid` out of `tracks` into the
 * `track_grids` side table, then reclaim the space.
 *
 * Why: those two columns averaged ~54KB per row, and SQLite stores a row's
 * columns together. That made `tracks` a ~820MB table, so ANY full scan had to
 * drag the whole file through disk even when the query asked for a handful of
 * tiny columns. Measured on a real library:
 *
 *     SELECT id                          105 ms
 *     SELECT id, title, artist, bpm …   8081 ms   <- same rows, small columns
 *
 * Not shipping the grids to the renderer (the earlier fix) removed the transfer
 * and the GC storm, but the read itself was still paying for them. With the
 * blobs out of line, `tracks` rows are ~1KB and the scan reads a fraction of it.
 *
 * VACUUM is part of the job, not an optional extra: dropping a column leaves the
 * old bytes in place as free pages, so without it the table is still spread over
 * the same number of pages and the scan is no faster.
 */
import type Database from 'better-sqlite3'

export interface MoveGridsResult {
  ran: boolean
  rowsMoved: number
  /** File size before/after, in MB — the point of the VACUUM. */
  sizeBeforeMb: number
  sizeAfterMb: number
}

/** True once `tracks` no longer carries the grid columns. */
export function areGridsMovedOut(db: Database.Database): boolean {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('tracks')`).all() as { name: string }[]
  return !cols.some((c) => c.name === 'beatgrid')
}

const fileMb = (db: Database.Database): number => {
  const page = (db.prepare('SELECT * FROM pragma_page_size()').get() as Record<string, number>)
  const count = (db.prepare('SELECT * FROM pragma_page_count()').get() as Record<string, number>)
  return +(((Object.values(page)[0] ?? 0) * (Object.values(count)[0] ?? 0)) / 1048576).toFixed(1)
}

export function moveGridsOutOfTracks(db: Database.Database): MoveGridsResult {
  const sizeBeforeMb = fileMb(db)
  if (areGridsMovedOut(db)) {
    return { ran: false, rowsMoved: 0, sizeBeforeMb, sizeAfterMb: sizeBeforeMb }
  }

  let rowsMoved = 0
  const copy = db.transaction(() => {
    // Only rows that actually carry a grid — an empty '[]' is the default and
    // needs no row of its own.
    const res = db.prepare(`
      INSERT OR REPLACE INTO track_grids (track_id, beatgrid, analysed_beatgrid)
      SELECT id, COALESCE(NULLIF(beatgrid, ''), '[]'), analysed_beatgrid
      FROM tracks
      WHERE (beatgrid IS NOT NULL AND beatgrid != '' AND beatgrid != '[]')
         OR analysed_beatgrid IS NOT NULL
    `).run()
    rowsMoved = res.changes
  })
  copy()

  // Outside the transaction: SQLite rewrites the table for each DROP COLUMN.
  db.exec('ALTER TABLE tracks DROP COLUMN beatgrid')
  db.exec('ALTER TABLE tracks DROP COLUMN analysed_beatgrid')

  // VACUUM cannot run inside a transaction, and is what actually shrinks the
  // file — without it the freed pages stay allocated and the scan stays slow.
  db.exec('VACUUM')

  return { ran: true, rowsMoved, sizeBeforeMb, sizeAfterMb: fileMb(db) }
}
