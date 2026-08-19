/**
 * Sync CLIENT — lets a second desktop mirror a host desktop's library.
 *
 * The app has always been able to SERVE its library (see server.ts); the phone
 * is the only thing that ever consumed it. This is the other half: a machine
 * that pulls someone else's library, lets you edit playlists and metadata
 * locally, and pushes those edits back.
 *
 * It deliberately carries no audio. A pull of a real 15.6k-track library is
 * ~19.5MB because the host strips grids and embeddings (leanTrack), so a client
 * is useful for library management on a machine that holds none of the files.
 *
 * Echo avoidance
 * --------------
 * Local edits are found by reading the same `sync_log` journal the triggers
 * already maintain — no separate change-tracking. But applying a PULL also
 * writes to those tables and so journals itself. Pushing blindly would send the
 * host its own changes straight back. Hence two cursors:
 *
 *   remoteCursor — how far through the HOST's journal we have consumed
 *   pushCursor   — how far through OUR journal we have already sent
 *
 * After applying a pull we jump pushCursor to the local high-water mark, which
 * marks everything the pull just wrote as "already known upstream".
 */
import type { Database } from 'better-sqlite3'
import { getSyncCursor, getChangesSince } from '../library/sync'
import { rowToTrack } from '../library/db'
import type {
  SyncPull, SyncPushPayload, TrackPatch, PlaylistPatch, Track, Playlist
} from '../../shared/types'

export interface SyncClientConfig {
  /** Host desktop, e.g. "192.168.1.160". */
  host: string
  port: number
  /** Bearer token from the host's pairing screen. */
  token: string
}

export interface SyncClientState {
  remoteCursor: number
  pushCursor: number
}

export interface PullResult {
  tracks: number
  playlists: number
  deletedTracks: number
  deletedPlaylists: number
  cursor: number
}

export interface PushResult {
  tracks: number
  playlists: number
  applied: number
  skipped: number
}

const DEVICE_HEADERS = (deviceId: string, deviceName: string): Record<string, string> => ({
  'x-device-id': deviceId,
  'x-device-name': deviceName
})

const base = (c: SyncClientConfig): string => `http://${c.host}:${c.port}`

/** Cheap reachability probe — /health needs no token, so it also works unpaired. */
export async function probeHost(
  c: Pick<SyncClientConfig, 'host' | 'port'>,
  timeoutMs = 5000
): Promise<{ ok: boolean; name?: string; version?: string; error?: string }> {
  try {
    const res = await fetch(`http://${c.host}:${c.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = (await res.json()) as { name?: string; version?: string }
    return { ok: true, name: j.name, version: j.version }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Write a pulled snapshot into the local database.
 *
 * The host is authoritative for a pull, so its values win — but grids are NOT
 * written: the host strips them from the wire, and treating that empty array as
 * truth would wipe any grid the client happens to hold.
 */
export function applyPulled(db: Database, pull: SyncPull): PullResult {
  const upsertTrack = db.prepare(`
    INSERT INTO tracks (
      id, file_path, title, artist, album, genre, year, label, bpm, key,
      duration_seconds, rating, color, energy, danceability, mood, play_count,
      last_played_at, date_added, updated_at, comment, tags, custom_tags,
      cue_points, source_ids, file_size, file_type, sample_rate, bit_depth,
      gain_db, content_hash, beatgrid_markers, analysed_source,
      analysed_median_bpm, analysed_confidence
    ) VALUES (
      @id, @filePath, @title, @artist, @album, @genre, @year, @label, @bpm, @key,
      @durationSeconds, @rating, @color, @energy, @danceability, @mood, @playCount,
      @lastPlayedAt, @dateAdded, @updatedAt, @comment, @tags, @customTags,
      @cuePoints, @sourceIds, @fileSize, @fileType, @sampleRate, @bitDepth,
      @gainDb, @contentHash, @markers, @analysedSource,
      @analysedMedianBpm, @analysedConfidence
    )
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path, title = excluded.title,
      artist = excluded.artist, album = excluded.album, genre = excluded.genre,
      year = excluded.year, label = excluded.label, bpm = excluded.bpm,
      key = excluded.key, duration_seconds = excluded.duration_seconds,
      rating = excluded.rating, color = excluded.color, energy = excluded.energy,
      danceability = excluded.danceability, mood = excluded.mood,
      play_count = excluded.play_count, last_played_at = excluded.last_played_at,
      updated_at = excluded.updated_at, comment = excluded.comment,
      tags = excluded.tags, custom_tags = excluded.custom_tags,
      cue_points = excluded.cue_points, source_ids = excluded.source_ids,
      file_size = excluded.file_size, file_type = excluded.file_type,
      sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth,
      gain_db = excluded.gain_db, content_hash = excluded.content_hash,
      beatgrid_markers = excluded.beatgrid_markers,
      analysed_source = excluded.analysed_source,
      analysed_median_bpm = excluded.analysed_median_bpm,
      analysed_confidence = excluded.analysed_confidence
  `)

  const upsertPlaylist = db.prepare(`
    INSERT INTO playlists (id, name, color, is_folder, is_smart, rules, parent_id, sort_order, source_ids)
    VALUES (@id, @name, @color, @isFolder, @isSmart, @rules, @parentId, @sortOrder, @sourceIds)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, color = excluded.color, is_folder = excluded.is_folder,
      is_smart = excluded.is_smart, rules = excluded.rules,
      parent_id = excluded.parent_id, sort_order = excluded.sort_order,
      source_ids = excluded.source_ids, updated_at = datetime('now')
  `)
  const clearMembers = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?')
  const addMember = db.prepare(
    'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
  )
  const trackExists = db.prepare('SELECT 1 AS ok FROM tracks WHERE id = ?')
  const delTrack = db.prepare('DELETE FROM tracks WHERE id = ?')
  const delPlaylist = db.prepare('DELETE FROM playlists WHERE id = ?')

  const run = db.transaction(() => {
    for (const t of pull.tracks) upsertTrack.run(trackParams(t))
    for (const p of pull.playlists) {
      upsertPlaylist.run({
        id: p.id,
        name: p.name,
        color: p.color ?? '#8A8474',
        isFolder: p.isFolder ? 1 : 0,
        isSmart: p.isSmart ? 1 : 0,
        rules: JSON.stringify(p.rules ?? []),
        parentId: p.parentId ?? null,
        sortOrder: p.sortOrder ?? 0,
        sourceIds: JSON.stringify(p.sourceIds ?? {})
      })
      // Membership is sent whole, so mirror it rather than merging: a track
      // removed upstream must disappear here too.
      clearMembers.run(p.id)
      let order = 0
      for (const tid of p.trackIds ?? []) {
        if (trackExists.get(tid)) addMember.run(p.id, tid, order++)
      }
    }
    for (const id of pull.deletedTrackIds ?? []) delTrack.run(id)
    for (const id of pull.deletedPlaylistIds ?? []) delPlaylist.run(id)
  })
  run()

  return {
    tracks: pull.tracks.length,
    playlists: pull.playlists.length,
    deletedTracks: (pull.deletedTrackIds ?? []).length,
    deletedPlaylists: (pull.deletedPlaylistIds ?? []).length,
    cursor: pull.cursor
  }
}

function trackParams(t: Track): Record<string, unknown> {
  return {
    id: t.id,
    filePath: t.filePath,
    title: t.title,
    artist: t.artist,
    album: t.album,
    genre: t.genre,
    year: t.year,
    label: t.label,
    bpm: t.bpm,
    key: t.key,
    durationSeconds: t.durationSeconds,
    rating: t.rating,
    color: t.color,
    energy: t.energy,
    danceability: t.danceability,
    mood: t.mood,
    playCount: t.playCount,
    lastPlayedAt: t.lastPlayedAt,
    dateAdded: t.dateAdded,
    updatedAt: t.updatedAt,
    comment: t.comment,
    tags: JSON.stringify(t.tags ?? []),
    customTags: JSON.stringify(t.customTags ?? {}),
    cuePoints: JSON.stringify(t.cuePoints ?? []),
    sourceIds: JSON.stringify(t.sourceIds ?? {}),
    fileSize: t.fileSize ?? null,
    fileType: t.fileType ?? null,
    sampleRate: t.sampleRate ?? null,
    bitDepth: t.bitDepth ?? null,
    gainDb: t.gainDb ?? null,
    contentHash: (t as unknown as { contentHash?: string }).contentHash ?? null,
    // Summaries travel even though the grids themselves don't, so the client can
    // still show "has a grid" badges without ever holding one.
    markers: t.gridSummary?.markers ?? 0,
    analysedSource: t.gridSummary?.analysedSource ?? null,
    analysedMedianBpm: t.gridSummary?.analysedMedianBpm ?? null,
    analysedConfidence: t.gridSummary?.analysedConfidence ?? null
  }
}

/** Fetch changes since `state.remoteCursor` and apply them locally. */
export async function pull(
  db: Database,
  config: SyncClientConfig,
  state: SyncClientState,
  deviceId: string,
  deviceName: string
): Promise<{ result: PullResult; state: SyncClientState }> {
  const res = await fetch(`${base(config)}/sync/pull?cursor=${state.remoteCursor}`, {
    headers: { authorization: `Bearer ${config.token}`, ...DEVICE_HEADERS(deviceId, deviceName) },
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) throw new Error(`pull failed: HTTP ${res.status}`)
  const body = (await res.json()) as SyncPull

  const result = applyPulled(db, body)
  // Everything the apply just journalled locally is, by definition, already
  // upstream — skip past it so the next push doesn't send it straight back.
  return {
    result,
    state: { remoteCursor: body.cursor, pushCursor: getSyncCursor(db) }
  }
}

/** Build patches for local edits made since `state.pushCursor` and send them. */
export async function push(
  db: Database,
  config: SyncClientConfig,
  state: SyncClientState,
  deviceId: string,
  deviceName: string
): Promise<{ result: PushResult; state: SyncClientState }> {
  const changes = getChangesSince(db, state.pushCursor)
  const payload = buildPushPayload(db, changes)
  const total = (payload.tracks?.length ?? 0) + (payload.playlists?.length ?? 0)
  if (total === 0) {
    return { result: { tracks: 0, playlists: 0, applied: 0, skipped: 0 }, state }
  }

  const res = await fetch(`${base(config)}/sync/push`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      ...DEVICE_HEADERS(deviceId, deviceName)
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) throw new Error(`push failed: HTTP ${res.status}`)
  const j = (await res.json()) as {
    appliedTracks?: number; skippedTracks?: number
    appliedPlaylists?: number; skippedPlaylists?: number
  }

  return {
    result: {
      tracks: payload.tracks?.length ?? 0,
      playlists: payload.playlists?.length ?? 0,
      applied: (j.appliedTracks ?? 0) + (j.appliedPlaylists ?? 0),
      skipped: (j.skippedTracks ?? 0) + (j.skippedPlaylists ?? 0)
    },
    // Only advance on success: a failed push must be retried, not silently lost.
    state: { ...state, pushCursor: getSyncCursor(db) }
  }
}

/** Turn journal entries into wire patches, reading current local state. */
export function buildPushPayload(
  db: Database,
  changes: { entity: string; entityId: string; op: string }[]
): SyncPushPayload {
  const tracks: TrackPatch[] = []
  const playlists: PlaylistPatch[] = []
  const now = new Date().toISOString()

  for (const c of changes) {
    if (c.entity === 'track') {
      if (c.op === 'delete') continue // the client never deletes host tracks
      const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(c.entityId) as
        | Record<string, unknown>
        | undefined
      if (!row) continue
      const t = rowToTrack(row)
      tracks.push({
        id: t.id,
        updatedAt: t.updatedAt ?? now,
        rating: t.rating,
        energy: t.energy,
        mood: t.mood,
        comment: t.comment,
        color: t.color,
        tags: t.tags,
        customTags: t.customTags,
        cuePoints: t.cuePoints
      })
    } else if (c.entity === 'playlist') {
      if (c.op === 'delete') {
        playlists.push({ id: c.entityId, updatedAt: now, deleted: true })
        continue
      }
      const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(c.entityId) as
        | Record<string, unknown>
        | undefined
      if (!row) continue
      const trackIds = (
        db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order')
          .all(c.entityId) as { track_id: string }[]
      ).map((r) => r.track_id)
      playlists.push({
        id: row.id as string,
        updatedAt: (row.updated_at as string) ?? now,
        name: row.name as string,
        color: (row.color as string) ?? undefined,
        isSmart: Boolean(row.is_smart),
        rules: JSON.parse((row.rules as string) || '[]'),
        trackIds
      })
    }
  }
  return { tracks, playlists }
}

/** Convenience for the UI: a playlist as the client sees it. */
export type { Playlist }
