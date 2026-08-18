/**
 * Keep the sync journal bounded.
 *
 * sync_log is append-only: triggers add a row on every track/playlist write, and
 * nothing ever removed one. A real library reached 128,283 rows — and a single
 * library-wide operation (an import, or the dedupe migration) adds one per track.
 * Left alone it grows without limit for the lifetime of the install.
 *
 * Compaction is safe because of how the journal is read. getChangesSince does:
 *
 *     SELECT entity, entity_id, op, MAX(seq) ... WHERE seq > ? GROUP BY entity, entity_id
 *
 * so only the highest seq per entity can ever affect a result, for ANY cursor
 * value. Dropping the older rows for an entity is therefore invisible to every
 * client, no matter how far behind it is — and because the row holding the global
 * MAX(seq) is by definition the max for its own entity, it always survives and
 * getSyncCursor is unchanged.
 *
 * That also gives the table a natural bound: one row per entity that still exists.
 */
import type { Database } from 'better-sqlite3'

/** Don't bother rewriting the table until there's a worthwhile amount to reclaim. */
const MIN_REDUNDANT_ROWS = 1000

export interface CompactResult {
  before: number
  after: number
  removed: number
}

/** True when there's enough redundancy to be worth a pass — mirrors the check below. */
export function syncLogCompactionPending(db: Database): boolean {
  const before = (db.prepare('SELECT COUNT(*) AS c FROM sync_log').get() as { c: number }).c
  const distinct = (
    db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM sync_log GROUP BY entity, entity_id)')
      .get() as { c: number }
  ).c
  return before - distinct >= MIN_REDUNDANT_ROWS
}

export function compactSyncLog(db: Database): CompactResult {
  const before = (db.prepare('SELECT COUNT(*) AS c FROM sync_log').get() as { c: number }).c
  const distinct = (
    db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM sync_log GROUP BY entity, entity_id)')
      .get() as { c: number }
  ).c

  if (before - distinct < MIN_REDUNDANT_ROWS) {
    return { before, after: before, removed: 0 }
  }

  db.prepare(
    `DELETE FROM sync_log
      WHERE seq NOT IN (SELECT MAX(seq) FROM sync_log GROUP BY entity, entity_id)`
  ).run()

  const after = (db.prepare('SELECT COUNT(*) AS c FROM sync_log').get() as { c: number }).c
  return { before, after, removed: before - after }
}
