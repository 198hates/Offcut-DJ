import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { applySchema } from './schema'
import { dedupeTracksByFilePath } from './migrations/dedupe-tracks'
import { backfillGridSummaries } from './grid-summary'
import { compactSyncLog } from './sync-log-compact'
import type { Track, TrackInput, Playlist } from '../../shared/types'

let _db: Database.Database | null = null

export function getLibraryDb(): Database.Database {
  if (_db) return _db

  const dbPath = join(app.getPath('userData'), 'library.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  applySchema(_db)

  // Repair libraries duplicated by the old ON CONFLICT(id) upsert, and install
  // the UNIQUE(file_path) index the new upsert keys on. Self-skipping once the
  // index exists, so this costs one index lookup on every later launch.
  try {
    const res = dedupeTracksByFilePath(_db)
    if (res.ran && res.removed > 0) {
      console.info(
        `[library] de-duplicated ${res.removed} track rows (${res.before} → ${res.after}); ` +
        `repointed ${res.playlistRefsRepointed} playlist entries`
      )
    }
  } catch (err) {
    // A library that can't be de-duplicated is still usable — it just stays
    // slow and keeps duplicating. Better than refusing to open at all.
    console.error('[library] track de-duplication failed:', (err as Error).message)
  }

  // Populate the grid summary columns for libraries written before they existed.
  // One pass; afterwards the write paths keep them current.
  try {
    const filled = backfillGridSummaries(_db)
    if (filled > 0) console.info(`[library] backfilled grid summaries for ${filled} tracks`)
  } catch (err) {
    console.error('[library] grid summary backfill failed:', (err as Error).message)
  }

  // The change journal is append-only and nothing ever pruned it; a single
  // library-wide import adds a row per track. Collapsing to the newest row per
  // entity is invisible to any client (see compactSyncLog) and bounds the table.
  try {
    const res = compactSyncLog(_db)
    if (res.removed > 0) {
      console.info(`[library] compacted sync journal: ${res.before} → ${res.after} rows`)
    }
  } catch (err) {
    console.error('[library] sync journal compaction failed:', (err as Error).message)
  }

  return _db
}

/** Absolute path to the library database file. */
export function libraryDbPath(): string {
  return join(app.getPath('userData'), 'library.db')
}

/** Close the DB handle (used before restoring a snapshot over the file). */
export function closeLibraryDb(): void {
  try { _db?.close() } catch { /* already closed */ }
  _db = null
}

/**
 * Every tracks column EXCEPT the two grid blobs. `beatgrid` (509MB) and
 * `analysed_beatgrid` (260MB) dominate a real library, so selecting them for a
 * list read costs seconds in SQLite, hundreds of MB over IPC, and a renderer
 * GC storm. The grid summaries below carry what lists actually display.
 *
 * Spelled out rather than "SELECT *" on purpose: a future blob column added to
 * tracks should have to be opted in here, not silently join the list payload.
 */
export const LIST_COLUMNS = `
  id, file_path, title, artist, album, genre, year, label, bpm, key,
  duration_seconds, rating, color, energy, danceability, mood, play_count,
  last_played_at, date_added, updated_at, comment, tags, custom_tags,
  cue_points, edit_lineage, source_ids, file_size, file_type, sample_rate,
  bit_depth, gain_db, phrases, overview_peaks, content_hash, embedding,
  beatgrid_markers, analysed_source, analysed_median_bpm, analysed_confidence,
  (analysed_beatgrid IS NOT NULL) AS has_analysed
`
// `embedding` stays in the list despite being a blob-ish column: similarity
// search (TrackDetail candidates, roadNotTaken, Health duplicate detection,
// SetBuilder) scans it across the WHOLE library, so fetching it per-track would
// mean fetching all of it anyway. It measures 0.0MB today. If that changes,
// move it behind an on-demand fetch like the grids rather than growing this list.

export function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: row.id as string,
    filePath: row.file_path as string,
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string,
    genre: row.genre as string,
    year: (row.year as number | null) ?? null,
    label: (row.label as string) || '',
    bpm: row.bpm as number | null,
    key: row.key as string | null,
    durationSeconds: row.duration_seconds as number | null,
    rating: row.rating as number,
    color: (row.color as string) || '',
    energy: (row.energy as number | null) ?? null,
    danceability: (row.danceability as number | null) ?? null,
    mood: (row.mood as number | null) ?? null,
    playCount: (row.play_count as number) ?? 0,
    lastPlayedAt: (row.last_played_at as string | null) ?? null,
    dateAdded: row.date_added as string,
    comment: row.comment as string,
    tags: JSON.parse(row.tags as string),
    customTags: JSON.parse((row.custom_tags as string) || '{}'),
    cuePoints: JSON.parse(row.cue_points as string),
    // Absent when the caller selected the lean list column set: the grids are
    // deliberately not fetched there (see LIST_COLUMNS), so default rather than
    // parse — `undefined` would break every `track.beatgrid.length` in the UI.
    beatgrid: row.beatgrid ? JSON.parse(row.beatgrid as string) : [],
    analysedBeatgrid: row.analysed_beatgrid
      ? JSON.parse(row.analysed_beatgrid as string)
      : null,
    gridSummary: {
      markers: (row.beatgrid_markers as number | null) ?? 0,
      // `has_analysed` on lean rows; on a full row fall back to the grid itself.
      hasAnalysed: row.has_analysed != null
        ? Boolean(row.has_analysed)
        : row.analysed_beatgrid != null,
      analysedSource: (row.analysed_source as string | null) ?? null,
      analysedMedianBpm: (row.analysed_median_bpm as number | null) ?? null,
      analysedConfidence: (row.analysed_confidence as number | null) ?? null
    },
    editLineage: row.edit_lineage
      ? JSON.parse(row.edit_lineage as string)
      : null,
    sourceIds: JSON.parse(row.source_ids as string),
    updatedAt: (row.updated_at as string | null) ?? null,
    fileSize:   (row.file_size   as number | null) ?? null,
    fileType:   (row.file_type   as string | null) ?? null,
    sampleRate: (row.sample_rate as number | null) ?? null,
    bitDepth:   (row.bit_depth   as number | null) ?? null,
    gainDb:     (row.gain_db     as number | null) ?? null,
    phrases:    row.phrases ? JSON.parse(row.phrases as string) : null,
    embedding:  row.embedding ? JSON.parse(row.embedding as string) : null,
    overviewPeaks: row.overview_peaks ? JSON.parse(row.overview_peaks as string) : null,
  }
}

export function rowToPlaylist(
  row: Record<string, unknown>,
  trackIds: string[] = []
): Playlist {
  return {
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string) || '#8A8474',
    isFolder: Boolean(row.is_folder),
    isSmart: Boolean(row.is_smart),
    isAutoGroup: Boolean(row.is_auto_group),
    rules: JSON.parse((row.rules as string) || '[]'),
    parentId: (row.parent_id as string) || null,
    sortOrder: row.sort_order as number,
    trackIds,
    sourceIds: JSON.parse(row.source_ids as string),
    createdAt: row.created_at as string
  }
}

export function insertOrUpdateTrack(db: Database.Database, track: TrackInput): void {
  db.prepare(`
    INSERT INTO tracks (
      id, file_path, title, artist, album, genre, year, label, bpm, key,
      duration_seconds, rating, energy, danceability, date_added, comment,
      tags, cue_points, beatgrid, source_ids,
      file_size, file_type, sample_rate, bit_depth, beatgrid_markers
    ) VALUES (
      @id, @filePath, @title, @artist, @album, @genre, @year, @label, @bpm, @key,
      @durationSeconds, @rating, @energy, @danceability, @dateAdded, @comment,
      @tags, @cuePoints, @beatgrid, @sourceIds,
      @fileSize, @fileType, @sampleRate, @bitDepth,
      /* Derived inline rather than via a follow-up refreshGridSummary() call:
         importers run this once per track, and a second UPDATE per row would
         double the write cost of a 15k-track import. */
      COALESCE(json_array_length(NULLIF(@beatgrid, '')), 0)
    )
    /* Keyed on file_path, NOT id. Every importer mints a fresh randomUUID() per
       track, so ON CONFLICT(id) could never fire on a re-import: it appended a
       whole second copy of the library instead of updating, and none of the
       "preserve the user's edits" branches below ever ran. file_path is the
       stable identity of a track and carries a UNIQUE index (added by the
       dedupe-tracks migration). The existing row keeps its own id, so playlist
       and history references survive. */
    ON CONFLICT(file_path) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      genre = excluded.genre,
      /* year + label: update if we now have a value and didn't before */
      year  = COALESCE(year,  excluded.year),
      label = CASE WHEN label = '' THEN excluded.label ELSE label END,
      bpm = excluded.bpm,
      key = excluded.key,
      duration_seconds = excluded.duration_seconds,
      /* rating: keep existing if import sends 0 (e.g. Serato hardcodes 0) */
      rating = CASE WHEN excluded.rating > 0 THEN excluded.rating ELSE rating END,
      /* energy + danceability: preserve analyzed value */
      energy = COALESCE(energy, excluded.energy),
      danceability = COALESCE(danceability, excluded.danceability),
      /* color, play_count, last_played_at are user data — never overwritten */
      /* comment / tags / cues / grid are ALSO user-editable: a re-import only
         fills them when empty instead of clobbering local edits with whatever
         the external library happens to hold */
      comment = CASE WHEN comment IS NULL OR comment = '' THEN excluded.comment ELSE comment END,
      tags = CASE WHEN tags IS NULL OR tags = '' OR tags = '[]' THEN excluded.tags ELSE tags END,
      cue_points = CASE WHEN cue_points IS NULL OR cue_points = '' OR cue_points = '[]' THEN excluded.cue_points ELSE cue_points END,
      beatgrid = CASE WHEN beatgrid IS NULL OR beatgrid = '' OR beatgrid = '[]' THEN excluded.beatgrid ELSE beatgrid END,
      /* Must mirror the CASE above exactly, or the badge disagrees with the grid. */
      beatgrid_markers = COALESCE(json_array_length(NULLIF(
        CASE WHEN beatgrid IS NULL OR beatgrid = '' OR beatgrid = '[]' THEN excluded.beatgrid ELSE beatgrid END, '')), 0),
      source_ids = excluded.source_ids,
      /* file info: fill in if not yet set */
      file_size   = COALESCE(file_size,   excluded.file_size),
      file_type   = COALESCE(file_type,   excluded.file_type),
      sample_rate = COALESCE(sample_rate, excluded.sample_rate),
      bit_depth   = COALESCE(bit_depth,   excluded.bit_depth),
      updated_at = datetime('now')
  `).run({
    id: track.id,
    filePath: track.filePath,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    year: track.year,
    label: track.label,
    bpm: track.bpm,
    key: track.key,
    durationSeconds: track.durationSeconds,
    rating: track.rating,
    energy: track.energy,
    danceability: track.danceability,
    dateAdded: track.dateAdded,
    comment: track.comment,
    tags: JSON.stringify(track.tags),
    cuePoints: JSON.stringify(track.cuePoints),
    beatgrid: JSON.stringify(track.beatgrid),
    sourceIds: JSON.stringify(track.sourceIds),
    fileSize: track.fileSize ?? null,
    fileType: track.fileType ?? null,
    sampleRate: track.sampleRate ?? null,
    bitDepth: track.bitDepth ?? null,
  })
}
