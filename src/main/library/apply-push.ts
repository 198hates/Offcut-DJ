// Apply prep edits pushed from the phone into the library, with a
// last-writer-wins merge. Pure given a db handle, so it's unit-testable against
// an in-memory database. Writes go through the normal tables, so the sync
// triggers journal them and other clients (and the desktop UI) pick them up.

import type { Database } from 'better-sqlite3'
import { getSyncCursor } from './sync'
import type { SyncPushPayload, SyncPushResult, TrackPatch, PlaylistPatch } from '../../shared/types'

/** Parse a timestamp (ISO or SQLite 'YYYY-MM-DD HH:MM:SS') to epoch ms; null/garbage → 0. */
function ms(ts: string | null | undefined): number {
  if (!ts) return 0
  // SQLite's space-separated UTC form isn't ISO — normalise it.
  const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts
  const n = Date.parse(norm)
  return Number.isNaN(n) ? 0 : n
}

// Patch key → column, with which values are JSON-encoded on the way in.
const TRACK_COLUMNS: { key: keyof TrackPatch; col: string; json?: boolean }[] = [
  { key: 'rating', col: 'rating' },
  { key: 'energy', col: 'energy' },
  { key: 'mood', col: 'mood' },
  { key: 'comment', col: 'comment' },
  { key: 'color', col: 'color' },
  { key: 'tags', col: 'tags', json: true },
  { key: 'customTags', col: 'custom_tags', json: true },
  { key: 'cuePoints', col: 'cue_points', json: true },
  { key: 'beatgrid', col: 'beatgrid', json: true },
  { key: 'analysedBeatgrid', col: 'analysed_beatgrid', json: true }
]

function applyTrackPatch(db: Database, patch: TrackPatch): boolean {
  // Resolve identity: prefer the desktop id, fall back to content hash.
  let row = db.prepare('SELECT id, updated_at FROM tracks WHERE id = ?').get(patch.id) as
    | { id: string; updated_at: string | null }
    | undefined
  if (!row && patch.contentHash) {
    row = db.prepare('SELECT id, updated_at FROM tracks WHERE content_hash = ?').get(patch.contentHash) as
      | { id: string; updated_at: string | null }
      | undefined
  }
  if (!row) return false // phone can't create tracks — no audio file here
  // Last-writer-wins: ignore an edit older than what we already have.
  if (ms(patch.updatedAt) < ms(row.updated_at)) return false

  const sets: string[] = []
  const values: unknown[] = []
  for (const { key, col, json } of TRACK_COLUMNS) {
    if (!(key in patch)) continue
    const v = patch[key]
    sets.push(`${col} = ?`)
    values.push(v === null || v === undefined ? null : json ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return false
  sets.push('updated_at = ?')
  values.push(patch.updatedAt)
  values.push(row.id)
  db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return true
}

function replaceMembership(db: Database, playlistId: string, trackIds: string[]): void {
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId)
  const exists = db.prepare('SELECT 1 FROM tracks WHERE id = ?')
  const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
  let order = 0
  for (const tid of trackIds) {
    if (exists.get(tid)) ins.run(playlistId, tid, order++)
  }
}

function applyPlaylistPatch(db: Database, patch: PlaylistPatch): boolean {
  const row = db.prepare('SELECT id, updated_at FROM playlists WHERE id = ?').get(patch.id) as
    | { id: string; updated_at: string | null }
    | undefined

  if (patch.deleted) {
    if (!row) return false
    if (ms(patch.updatedAt) < ms(row.updated_at)) return false
    db.prepare('DELETE FROM playlists WHERE id = ?').run(patch.id)
    return true
  }

  if (!row) {
    // Create — the phone supplies the id (a uuid it generated).
    db.prepare('INSERT INTO playlists (id, name, color, updated_at) VALUES (?, ?, ?, ?)').run(
      patch.id,
      patch.name ?? 'Playlist',
      patch.color ?? '#8A8474',
      patch.updatedAt
    )
    if (patch.trackIds) replaceMembership(db, patch.id, patch.trackIds)
    return true
  }

  if (ms(patch.updatedAt) < ms(row.updated_at)) return false
  const sets: string[] = []
  const values: unknown[] = []
  if ('name' in patch && patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if ('color' in patch && patch.color !== undefined) {
    sets.push('color = ?')
    values.push(patch.color)
  }
  sets.push('updated_at = ?')
  values.push(patch.updatedAt)
  values.push(patch.id)
  db.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  if (patch.trackIds) replaceMembership(db, patch.id, patch.trackIds)
  return true
}

/** Apply a pushed payload atomically and report what landed. */
export function applyPush(db: Database, payload: SyncPushPayload): SyncPushResult {
  let appliedTracks = 0
  let skippedTracks = 0
  let appliedPlaylists = 0
  let skippedPlaylists = 0

  const run = db.transaction(() => {
    for (const t of payload.tracks ?? []) {
      if (applyTrackPatch(db, t)) appliedTracks++
      else skippedTracks++
    }
    for (const p of payload.playlists ?? []) {
      if (applyPlaylistPatch(db, p)) appliedPlaylists++
      else skippedPlaylists++
    }
  })
  run()

  return { appliedTracks, skippedTracks, appliedPlaylists, skippedPlaylists, cursor: getSyncCursor(db) }
}
