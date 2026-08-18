/**
 * Small denormalised summaries of a track's beat grids.
 *
 * beatgrid + analysed_beatgrid hold ~770MB of JSON on a real library (509MB and
 * 260MB respectively across 15.6k tracks). The library list used to `SELECT *`
 * and ship all of it to the renderer on every load, which is what pinned the
 * renderer at 100% CPU with a blank window for minutes — a captured profile put
 * 41.8% of renderer time in GC and 39.6% in V8 internals, against 4.2% in actual
 * app code.
 *
 * Everything the library, health, search and analyse views *display* about a
 * grid is tiny: whether one exists, where it came from, its median BPM and how
 * confident it is. Storing those four values lets the list query avoid reading
 * the blobs at all — the full grids are fetched per-track, on demand, only when
 * something actually needs to draw or edit them.
 */
import type Database from 'better-sqlite3'

/** Recomputed from the stored JSON, so it cannot drift from whatever was written. */
export const GRID_SUMMARY_SQL = `
  beatgrid_markers = COALESCE(json_array_length(
    CASE WHEN beatgrid IS NULL OR beatgrid = '' THEN '[]' ELSE beatgrid END), 0),
  analysed_source = json_extract(analysed_beatgrid, '$.source'),
  analysed_median_bpm = json_extract(analysed_beatgrid, '$.medianBpm'),
  analysed_confidence = (
    SELECT AVG(json_extract(b.value, '$.confidence'))
    FROM json_each(COALESCE(json_extract(analysed_beatgrid, '$.beats'), '[]')) b
  )
`

/** Refresh the summaries for one track. Call after any write that touches a grid. */
export function refreshGridSummary(db: Database.Database, trackId: string): void {
  try {
    db.prepare(`UPDATE tracks SET ${GRID_SUMMARY_SQL} WHERE id = ?`).run(trackId)
  } catch {
    // Malformed grid JSON must not take down the write that triggered this —
    // a stale summary only affects a badge, the real grid is still intact.
  }
}

/** How many rows still need summaries — 0 means the backfill is a no-op. */
export function gridSummaryBackfillPending(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM tracks
         WHERE beatgrid_markers = 0 AND beatgrid IS NOT NULL AND beatgrid != '' AND beatgrid != '[]'`
      )
      .get() as { c: number }
  ).c
}

/**
 * One-time backfill for libraries written before the summary columns existed.
 * Detected by "no row has a marker count yet" rather than a version flag, so it
 * self-heals if a write path ever misses one.
 */
export function backfillGridSummaries(db: Database.Database): number {
  const pending = { c: gridSummaryBackfillPending(db) }
  if (pending.c === 0) return 0

  db.prepare(
    `UPDATE tracks SET ${GRID_SUMMARY_SQL}
     WHERE (beatgrid IS NOT NULL AND beatgrid != '' AND beatgrid != '[]')
        OR analysed_beatgrid IS NOT NULL`
  ).run()
  return pending.c
}
