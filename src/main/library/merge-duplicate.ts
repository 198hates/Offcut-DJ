/**
 * Merging one duplicate track into the copy the user is keeping.
 *
 * The Health duplicate tool used to call replaceTrackInPlaylists, which moved
 * playlist entries across and nothing else. Everything the losing row carried —
 * cues, beatgrid, rating, comment, tags, energy, the analysis embedding — went
 * in the bin with it. trackScore() prefers a cued copy when the tool picks the
 * keeper for you, so the common case survived by luck; a manual selection, or a
 * group where the cues live on one copy and the rating and comment on another,
 * silently lost work. Duplicate sets on a real library are usually exactly that:
 * an older copy that has been cued and rated, and a newer clean re-download.
 *
 * So: fill every gap in the keeper from the loser before the loser is deleted.
 * The keeper's own values always win — this only ever populates a field the
 * keeper does not have. It is deliberately non-destructive to the loser: the
 * caller deletes that row (and optionally trashes its file) afterwards, so a
 * failure here leaves both rows intact rather than a half-merged pair.
 *
 * Not merged, on purpose:
 *  - file_path / date_added / created_at — identity and provenance of the keeper.
 *  - source_ids — the rekordbox/Serato ID of the losing row. Claiming it would
 *    silently repoint the rekordbox export at a different djmdContent row, which
 *    is a decision about export behaviour and not this function's business.
 *  - beatgrid_markers / analysed_* — derived, refreshed from the grid instead.
 */
import type Database from 'better-sqlite3'
import { refreshGridSummary } from './grid-summary'
import type { MergeDuplicateResult } from '../../shared/types'

/**
 * Columns worth rescuing, with the value that counts as "the keeper hasn't got
 * one". Mirrors MERGE_COLUMNS in migrations/dedupe-tracks.ts — that migration
 * repairs re-import duplicates, this handles user-resolved ones, and they should
 * agree about what a populated field looks like.
 */
const MERGE_COLUMNS: readonly { col: string; empty: string | null }[] = [
  // Text fields with a NOT NULL default, so "" / "[]" / "{}" means absent.
  { col: 'title', empty: "''" },
  { col: 'artist', empty: "''" },
  { col: 'album', empty: "''" },
  { col: 'genre', empty: "''" },
  { col: 'comment', empty: "''" },
  { col: 'color', empty: "''" },
  { col: 'label', empty: "''" },
  { col: 'tags', empty: "'[]'" },
  { col: 'cue_points', empty: "'[]'" },
  { col: 'custom_tags', empty: "'{}'" },
  // Nullable columns — NULL is the only "absent".
  { col: 'bpm', empty: null },
  { col: 'key', empty: null },
  { col: 'duration_seconds', empty: null },
  { col: 'energy', empty: null },
  { col: 'danceability', empty: null },
  { col: 'mood', empty: null },
  { col: 'gain_db', empty: null },
  { col: 'phrases', empty: null },
  { col: 'embedding', empty: null },
  { col: 'overview_peaks', empty: null },
  { col: 'content_hash', empty: null },
  { col: 'edit_lineage', empty: null },
  { col: 'year', empty: null },
  { col: 'file_size', empty: null },
  { col: 'file_type', empty: null },
  { col: 'sample_rate', empty: null },
  { col: 'bit_depth', empty: null }
]

/** A factory, not a shared constant: fieldsFilled is mutable, and handing every
 *  caller the same array would let one of them corrupt the others' results. */
const emptyResult = (): MergeDuplicateResult => ({
  fieldsFilled: [],
  playlistRefsMoved: 0,
  playHistoryRepointed: 0,
  gridClaimed: false,
  ratingRaised: false,
  playCountRaised: false,
  replacementRecorded: false
})

/** Is this value absent, by that column's definition of absent? */
function isEmpty(value: unknown, empty: string | null): boolean {
  if (value === null || value === undefined) return true
  if (empty === null) return false
  // The sentinels above are SQL literals ("''", "'[]'"); compare on the inside.
  return String(value) === empty.slice(1, -1)
}

/** The rekordbox ContentID a track carries, if any. */
function rekordboxIdOf(sourceIds: unknown): string | null {
  if (typeof sourceIds !== 'string' || sourceIds === '') return null
  try {
    const parsed = JSON.parse(sourceIds) as Record<string, unknown>
    const id = parsed?.rekordbox
    return id == null || id === '' ? null : String(id)
  } catch {
    // A malformed source_ids blob is not worth failing a merge over — it only
    // means this copy cannot be paired for the rekordbox prune.
    return null
  }
}

/** False on a database written before duplicate_replacements existed. */
function hasReplacementsTable(db: Database.Database): boolean {
  return !!db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='duplicate_replacements'`)
    .get()
}

/** A grid string that actually holds markers, rather than an empty placeholder. */
function hasGrid(value: string | null | undefined): boolean {
  return value != null && value !== '' && value !== '[]'
}

/**
 * Copy everything the keeper is missing across from a duplicate that is about to
 * be deleted, and move its playlist and play-history references over.
 *
 * Runs in one transaction. Returns what actually changed so the caller can tell
 * the user rather than claiming a merge that was a no-op.
 */
export function mergeDuplicateInto(
  db: Database.Database,
  loserId: string,
  keeperId: string
): MergeDuplicateResult {
  if (loserId === keeperId) return emptyResult()

  const cols = new Set(
    (db.prepare(`SELECT name FROM pragma_table_info('tracks')`).all() as { name: string }[]).map(
      (c) => c.name
    )
  )
  const mergeColumns = MERGE_COLUMNS.filter((c) => cols.has(c.col))
  const selectCols = [
    ...mergeColumns.map((c) => c.col),
    ...['rating', 'play_count', 'last_played_at', 'source_ids'].filter((c) => cols.has(c))
  ]

  const readRow = db.prepare(
    `SELECT ${selectCols.map((c) => `"${c}"`).join(', ')} FROM tracks WHERE id = ?`
  )
  const keeper = readRow.get(keeperId) as Record<string, unknown> | undefined
  const loser = readRow.get(loserId) as Record<string, unknown> | undefined
  // A missing row is not an error worth aborting a bulk resolve for — the caller
  // is mid-way through deleting things. Do nothing and report nothing.
  if (!keeper || !loser) return emptyResult()

  const result: MergeDuplicateResult = emptyResult()

  // Only the columns that are genuinely empty on the keeper and populated on the
  // loser. Building the UPDATE from just these keeps the write small — rows can
  // carry a large embedding and overview_peaks, and SQLite rewrites the whole row.
  const fills = mergeColumns.filter(
    ({ col, empty }) => isEmpty(keeper[col], empty) && !isEmpty(loser[col], empty)
  )

  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
  const raiseRating = cols.has('rating') && num(loser.rating) > num(keeper.rating)
  const raisePlays = cols.has('play_count') && num(loser.play_count) > num(keeper.play_count)
  // Lexical comparison is right for both storage formats in use here:
  // datetime('now') ("YYYY-MM-DD HH:MM:SS") and ISO-8601 both sort chronologically.
  const laterPlayed =
    cols.has('last_played_at') &&
    loser.last_played_at != null &&
    (keeper.last_played_at == null ||
      String(loser.last_played_at) > String(keeper.last_played_at))

  const run = db.transaction(() => {
    const sets: string[] = []
    const params: unknown[] = []
    for (const { col } of fills) {
      sets.push(`"${col}" = ?`)
      params.push(loser[col])
      result.fieldsFilled.push(col)
    }
    if (raiseRating) {
      sets.push('rating = ?')
      params.push(num(loser.rating))
      result.ratingRaised = true
    }
    if (raisePlays) {
      sets.push('play_count = ?')
      params.push(num(loser.play_count))
      result.playCountRaised = true
    }
    if (laterPlayed) {
      sets.push('last_played_at = ?')
      params.push(loser.last_played_at)
    }
    if (sets.length) {
      if (cols.has('updated_at')) sets.push(`updated_at = datetime('now')`)
      db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...params, keeperId)
    }

    // Beatgrids live out of line in track_grids, which cascades on delete of the
    // track — so a grid only the loser has must be claimed before that delete or
    // it goes with it. Same reasoning as claimGrids in the dedupe migration.
    const loserGrid = db
      .prepare('SELECT beatgrid, analysed_beatgrid FROM track_grids WHERE track_id = ?')
      .get(loserId) as { beatgrid: string | null; analysed_beatgrid: string | null } | undefined
    if (loserGrid && (hasGrid(loserGrid.beatgrid) || hasGrid(loserGrid.analysed_beatgrid))) {
      const keeperGrid = db
        .prepare('SELECT beatgrid, analysed_beatgrid FROM track_grids WHERE track_id = ?')
        .get(keeperId) as { beatgrid: string | null; analysed_beatgrid: string | null } | undefined
      const keeperHas = keeperGrid && (hasGrid(keeperGrid.beatgrid) || hasGrid(keeperGrid.analysed_beatgrid))
      if (!keeperHas) {
        db.prepare(
          `INSERT INTO track_grids (track_id, beatgrid, analysed_beatgrid) VALUES (?, ?, ?)
           ON CONFLICT(track_id) DO UPDATE SET
             beatgrid = excluded.beatgrid,
             analysed_beatgrid = excluded.analysed_beatgrid`
        ).run(keeperId, loserGrid.beatgrid ?? '[]', loserGrid.analysed_beatgrid ?? null)
        result.gridClaimed = true
      }
    }

    // Playlist entries: move the loser's where the keeper isn't already in that
    // playlist, drop them where it is (the PK is (playlist_id, track_id), so an
    // UPDATE into an occupied slot would fail the constraint).
    const rows = db
      .prepare('SELECT playlist_id FROM playlist_tracks WHERE track_id = ?')
      .all(loserId) as { playlist_id: string }[]
    const keeperPresent = db.prepare(
      'SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?'
    )
    const move = db.prepare(
      'UPDATE playlist_tracks SET track_id = ? WHERE playlist_id = ? AND track_id = ?'
    )
    const drop = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
    for (const { playlist_id } of rows) {
      if (keeperPresent.get(playlist_id, keeperId)) {
        drop.run(playlist_id, loserId)
      } else {
        move.run(keeperId, playlist_id, loserId)
        result.playlistRefsMoved++
      }
    }

    // Play history too, or the set-history timeline loses the plays that were
    // logged against whichever copy was loaded at the time.
    const ph = db
      .prepare('UPDATE play_history SET track_id = ? WHERE track_id = ?')
      .run(keeperId, loserId)
    result.playHistoryRepointed = ph.changes

    /* Record which rekordbox row this copy was replaced by, so the export can
       retire it on fact rather than guessing from a missing file. Only meaningful
       when the loser HAS a rekordbox row — otherwise rekordbox has nothing to
       retire and there is nothing to record. See duplicate_replacements in
       schema.ts for why this exists at all. */
    const removedRbId = rekordboxIdOf(loser.source_ids)
    if (removedRbId && hasReplacementsTable(db)) {
      db.prepare(
        `INSERT INTO duplicate_replacements (removed_rb_id, keeper_track_id)
         VALUES (?, ?)
         ON CONFLICT(removed_rb_id) DO UPDATE SET keeper_track_id = excluded.keeper_track_id`
      ).run(removedRbId, keeperId)
      result.replacementRecorded = true
    }
  })

  run()

  // Outside the transaction: derived summary columns, best-effort by design.
  if (result.gridClaimed) refreshGridSummary(db, keeperId)

  return result
}
