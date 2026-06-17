// Delta-sync core for the mobile companion / multi-device sync.
//
// Every write to tracks, playlists and playlist membership is journalled into
// `sync_log` by triggers (see schema.ts). A client holds a `cursor` (the last
// seq it has seen) and asks for everything newer. Pulling from cursor 0 returns
// a full snapshot, because rows that predate the triggers aren't in the journal.
//
// All functions take the db handle so they're unit-testable against an
// in-memory database, independent of Electron.

import type { Database } from 'better-sqlite3'
import { rowToTrack, rowToPlaylist } from './db'
import type { Track, Playlist, SyncChange, SyncPull } from '../../shared/types'

/**
 * Strip the heavy analysis arrays the phone doesn't need in the bulk library
 * mirror. The per-beat grids (`beatgrid`, `analysedBeatgrid`) run to hundreds of
 * KB per long mix — hundreds of MB across a full library — and the audio
 * `embedding` is desktop-only (not even in the mobile wire type). Sending them
 * bloats the snapshot enough to stall JSON.stringify and overflow the phone.
 * Browse + audition need none of it; per-track grids can be fetched on demand
 * when something actually renders them.
 */
export function leanTrack(t: Track): Track {
  return { ...t, beatgrid: [], analysedBeatgrid: null, embedding: null }
}

/** The current high-water mark of the journal. 0 means nothing logged yet. */
export function getSyncCursor(db: Database): number {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM sync_log').get() as { seq: number | null }
  return row.seq ?? 0
}

/**
 * Collapsed changes since `cursor` — one row per entity carrying its latest op,
 * ordered by seq. SQLite's bare-column rule means `op` is taken from the same
 * row as MAX(seq), so an entity that was upserted then deleted resolves to
 * 'delete' (and vice-versa).
 */
export function getChangesSince(db: Database, cursor: number): SyncChange[] {
  return db
    .prepare(
      `SELECT entity, entity_id AS entityId, op, MAX(seq) AS seq
         FROM sync_log
        WHERE seq > ?
        GROUP BY entity, entity_id
        ORDER BY seq`
    )
    .all(cursor) as SyncChange[]
}

function loadTrack(db: Database, id: string): Track | null {
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToTrack(row) : null
}

function loadPlaylist(db: Database, id: string): Playlist | null {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const trackIds = (
    db
      .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order')
      .all(id) as { track_id: string }[]
  ).map((r) => r.track_id)
  return rowToPlaylist(row, trackIds)
}

function allTracks(db: Database): Track[] {
  return (db.prepare('SELECT * FROM tracks').all() as Record<string, unknown>[]).map(rowToTrack)
}

function allPlaylists(db: Database): Playlist[] {
  const rows = db.prepare('SELECT * FROM playlists').all() as Record<string, unknown>[]
  return rows.map((row) => loadPlaylist(db, row.id as string)).filter((p): p is Playlist => p !== null)
}

/**
 * Pull everything that changed since `cursor`, hydrated into full entities.
 * `cursor <= 0` returns a full snapshot. The returned `cursor` is what the
 * client should send next time. Deleted ids let the client drop stale rows.
 */
export function pullChanges(db: Database, cursor: number): SyncPull {
  const nextCursor = getSyncCursor(db)

  // Initial sync: the journal can't describe rows created before the triggers
  // existed, so hand back the whole library.
  if (cursor <= 0) {
    return {
      cursor: nextCursor,
      tracks: allTracks(db),
      playlists: allPlaylists(db),
      deletedTrackIds: [],
      deletedPlaylistIds: []
    }
  }

  const changes = getChangesSince(db, cursor)
  const tracks: Track[] = []
  const playlists: Playlist[] = []
  const deletedTrackIds: string[] = []
  const deletedPlaylistIds: string[] = []

  for (const c of changes) {
    if (c.op === 'delete') {
      if (c.entity === 'track') deletedTrackIds.push(c.entityId)
      else deletedPlaylistIds.push(c.entityId)
      continue
    }
    if (c.entity === 'track') {
      const t = loadTrack(db, c.entityId)
      if (t) tracks.push(t)
      else deletedTrackIds.push(c.entityId) // raced with a delete after collapse
    } else {
      const p = loadPlaylist(db, c.entityId)
      if (p) playlists.push(p)
      else deletedPlaylistIds.push(c.entityId)
    }
  }

  return { cursor: nextCursor, tracks, playlists, deletedTrackIds, deletedPlaylistIds }
}
