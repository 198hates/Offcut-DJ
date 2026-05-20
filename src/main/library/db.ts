import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { applySchema } from './schema'
import type { Track, Playlist } from '../../shared/types'

let _db: Database.Database | null = null

export function getLibraryDb(): Database.Database {
  if (_db) return _db

  const dbPath = join(app.getPath('userData'), 'library.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  applySchema(_db)

  return _db
}

export function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: row.id as string,
    filePath: row.file_path as string,
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string,
    genre: row.genre as string,
    bpm: row.bpm as number | null,
    key: row.key as string | null,
    durationSeconds: row.duration_seconds as number | null,
    rating: row.rating as number,
    color: (row.color as string) || '',
    energy: (row.energy as number | null) ?? null,
    playCount: (row.play_count as number) ?? 0,
    lastPlayedAt: (row.last_played_at as string | null) ?? null,
    dateAdded: row.date_added as string,
    comment: row.comment as string,
    tags: JSON.parse(row.tags as string),
    cuePoints: JSON.parse(row.cue_points as string),
    beatgrid: JSON.parse(row.beatgrid as string),
    sourceIds: JSON.parse(row.source_ids as string)
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
    rules: JSON.parse((row.rules as string) || '[]'),
    parentId: (row.parent_id as string) || null,
    sortOrder: row.sort_order as number,
    trackIds,
    sourceIds: JSON.parse(row.source_ids as string)
  }
}

export function insertOrUpdateTrack(db: Database.Database, track: Track): void {
  db.prepare(`
    INSERT INTO tracks (
      id, file_path, title, artist, album, genre, bpm, key,
      duration_seconds, rating, energy, date_added, comment,
      tags, cue_points, beatgrid, source_ids
    ) VALUES (
      @id, @filePath, @title, @artist, @album, @genre, @bpm, @key,
      @durationSeconds, @rating, @energy, @dateAdded, @comment,
      @tags, @cuePoints, @beatgrid, @sourceIds
    )
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      genre = excluded.genre,
      bpm = excluded.bpm,
      key = excluded.key,
      duration_seconds = excluded.duration_seconds,
      /* rating: keep existing if import sends 0 (e.g. Serato hardcodes 0) */
      rating = CASE WHEN excluded.rating > 0 THEN excluded.rating ELSE rating END,
      /* energy: preserve analyzed value — only set from import if not yet analyzed */
      energy = COALESCE(energy, excluded.energy),
      /* color, play_count, last_played_at are user data — never overwritten */
      comment = excluded.comment,
      tags = excluded.tags,
      cue_points = excluded.cue_points,
      beatgrid = excluded.beatgrid,
      source_ids = excluded.source_ids,
      updated_at = datetime('now')
  `).run({
    id: track.id,
    filePath: track.filePath,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    bpm: track.bpm,
    key: track.key,
    durationSeconds: track.durationSeconds,
    rating: track.rating,
    energy: track.energy,
    dateAdded: track.dateAdded,
    comment: track.comment,
    tags: JSON.stringify(track.tags),
    cuePoints: JSON.stringify(track.cuePoints),
    beatgrid: JSON.stringify(track.beatgrid),
    sourceIds: JSON.stringify(track.sourceIds)
  })
}
