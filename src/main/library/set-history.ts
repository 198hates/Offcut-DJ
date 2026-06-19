// Set History — set-level metadata over is_history playlists.
//
// A played set's ordered tracks already live in an `is_history` playlist (from
// the Pioneer-USB importer or ProLink capture). This module adds the set-level
// layer: `set_sessions` rows with denormalised summary metrics (computed once),
// plus list/detail/update/delete. Backfill creates a session for every history
// playlist that doesn't have one yet, so existing history shows up immediately.

import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import type { SetDetail, SetListFilter, SetPatch, SetSummary, SetTrack, SetTransition } from '../../shared/types'

const DATE_RE = /(\d{4})[-./](\d{2})[-./](\d{2})/

/** Are two Camelot keys harmonically adjacent (same, ±1 on the wheel, or relative)? */
export function camelotAdjacent(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const A = a.trim().toUpperCase()
  const B = b.trim().toUpperCase()
  const pa = /^(\d{1,2})([AB])$/.exec(A)
  const pb = /^(\d{1,2})([AB])$/.exec(B)
  if (!pa || !pb) return A === B
  const na = +pa[1]
  const nb = +pb[1]
  if (pa[2] === pb[2]) {
    const d = Math.abs(na - nb)
    return d === 0 || d === 1 || d === 11 // same mode: same key or ±1 hour (wraps 12↔1)
  }
  return na === nb // relative major/minor
}

interface PlTrackRow {
  track_id: string
  title: string
  artist: string
  bpm: number | null
  key: string | null
  duration_seconds: number | null
  energy: number | null
}

function setTrackRows(db: Database, playlistId: string): PlTrackRow[] {
  return db
    .prepare(
      `SELECT t.id AS track_id, t.title, t.artist, t.bpm, t.key, t.duration_seconds, t.energy
         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ? ORDER BY pt.sort_order`
    )
    .all(playlistId) as PlTrackRow[]
}

interface Summary {
  track_count: number
  duration_sec: number | null
  avg_bpm: number | null
  bpm_min: number | null
  bpm_max: number | null
  energy_avg: number | null
  harmonic_pct: number | null
}

function summarize(rows: PlTrackRow[]): Summary {
  const bpms = rows.map((r) => r.bpm).filter((b): b is number => typeof b === 'number' && b > 0)
  const energies = rows.map((r) => r.energy).filter((e): e is number => typeof e === 'number')
  const dur = rows.reduce((s, r) => s + (r.duration_seconds || 0), 0)
  let harmonic = 0
  let pairs = 0
  for (let i = 1; i < rows.length; i++) {
    pairs++
    if (camelotAdjacent(rows[i - 1].key, rows[i].key)) harmonic++
  }
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    track_count: rows.length,
    duration_sec: dur || null,
    avg_bpm: bpms.length ? avg(bpms) : null,
    bpm_min: bpms.length ? Math.min(...bpms) : null,
    bpm_max: bpms.length ? Math.max(...bpms) : null,
    energy_avg: energies.length ? avg(energies) : null,
    harmonic_pct: pairs ? (harmonic / pairs) * 100 : null
  }
}

function derivePlayedOn(db: Database, name: string, playlistId: string): string | null {
  const m = DATE_RE.exec(name)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const row = db
    .prepare(
      `SELECT MIN(ph.played_at) AS first FROM play_history ph
         JOIN playlist_tracks pt ON pt.track_id = ph.track_id WHERE pt.playlist_id = ?`
    )
    .get(playlistId) as { first: string | null } | undefined
  return row?.first ?? null
}

/** Create a set_sessions row for every is_history playlist that lacks one. */
export function backfillSetSessions(db: Database): number {
  const playlists = db
    .prepare(
      `SELECT p.id, p.name FROM playlists p
        WHERE p.is_history = 1
          AND NOT EXISTS (SELECT 1 FROM set_sessions s WHERE s.playlist_id = p.id)`
    )
    .all() as { id: string; name: string }[]
  if (!playlists.length) return 0
  const ins = db.prepare(
    `INSERT INTO set_sessions
       (id, playlist_id, title, played_on, source, track_count, duration_sec, avg_bpm, bpm_min, bpm_max, energy_avg, harmonic_pct)
     VALUES
       (@id, @playlist_id, @title, @played_on, 'imported', @track_count, @duration_sec, @avg_bpm, @bpm_min, @bpm_max, @energy_avg, @harmonic_pct)`
  )
  const tx = db.transaction((rows: { id: string; name: string }[]) => {
    for (const pl of rows) {
      const s = summarize(setTrackRows(db, pl.id))
      ins.run({ id: randomUUID(), playlist_id: pl.id, title: pl.name, played_on: derivePlayedOn(db, pl.name, pl.id), ...s })
    }
  })
  tx(playlists)
  return playlists.length
}

interface SessionRow {
  id: string
  playlist_id: string | null
  title: string
  played_on: string | null
  source: string
  device: string | null
  venue: string | null
  residency_id: string | null
  rating: number | null
  vibe: string | null
  notes: string | null
  recording_path: string | null
  status: string
  track_count: number | null
  duration_sec: number | null
  avg_bpm: number | null
  bpm_min: number | null
  bpm_max: number | null
  energy_avg: number | null
  harmonic_pct: number | null
}

function toSummary(r: SessionRow): SetSummary {
  return {
    id: r.id,
    playlistId: r.playlist_id,
    title: r.title,
    playedOn: r.played_on,
    source: r.source,
    venue: r.venue,
    residencyId: r.residency_id,
    rating: r.rating,
    vibe: r.vibe,
    status: r.status,
    trackCount: r.track_count,
    durationSec: r.duration_sec,
    avgBpm: r.avg_bpm,
    bpmMin: r.bpm_min,
    bpmMax: r.bpm_max,
    energyAvg: r.energy_avg,
    harmonicPct: r.harmonic_pct
  }
}

/** Set summaries for the calendar/list (backfills first). Newest played first. */
export function listSets(db: Database, filter: SetListFilter = {}): SetSummary[] {
  backfillSetSessions(db)
  const where = filter.includeArchived ? '' : "WHERE status != 'archived'"
  const rows = db
    .prepare(`SELECT * FROM set_sessions ${where} ORDER BY (played_on IS NULL), played_on DESC, imported_at DESC`)
    .all() as SessionRow[]
  return rows.map(toSummary)
}

/** Full set: summary + ordered running order + transition deltas. */
export function getSet(db: Database, id: string): SetDetail | null {
  const r = db.prepare('SELECT * FROM set_sessions WHERE id = ?').get(id) as SessionRow | undefined
  if (!r) return null
  const rows = r.playlist_id ? setTrackRows(db, r.playlist_id) : []
  const tracks: SetTrack[] = rows.map((t) => ({
    trackId: t.track_id,
    title: t.title,
    artist: t.artist,
    bpm: t.bpm,
    key: t.key,
    durationSeconds: t.duration_seconds
  }))
  const transitions: SetTransition[] = []
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    transitions.push({
      index: i,
      bpmDelta: a.bpm != null && b.bpm != null ? +(b.bpm - a.bpm).toFixed(1) : null,
      harmonic: a.key && b.key ? camelotAdjacent(a.key, b.key) : null
    })
  }
  return { ...toSummary(r), device: r.device, notes: r.notes, recordingPath: r.recording_path, tracks, transitions }
}

const PATCH_COLS: Record<keyof SetPatch, string> = {
  title: 'title',
  venue: 'venue',
  rating: 'rating',
  vibe: 'vibe',
  notes: 'notes',
  status: 'status'
}

/** Update set-level metadata (rating/venue/vibe/notes/status/title). */
export function updateSet(db: Database, id: string, patch: SetPatch): SetDetail | null {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [k, col] of Object.entries(PATCH_COLS) as [keyof SetPatch, string][]) {
    if (patch[k] !== undefined) {
      sets.push(`${col} = ?`)
      values.push(patch[k])
    }
  }
  if (sets.length) {
    values.push(id)
    db.prepare(`UPDATE set_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }
  return getSet(db, id)
}

/** Hard-delete a set: removes the set_sessions row AND its history playlist
 *  (so a backfill won't resurrect it). Returns true if a row was removed. */
export function deleteSet(db: Database, id: string): boolean {
  const r = db.prepare('SELECT playlist_id FROM set_sessions WHERE id = ?').get(id) as
    | { playlist_id: string | null }
    | undefined
  if (!r) return false
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM set_sessions WHERE id = ?').run(id)
    if (r.playlist_id) db.prepare('DELETE FROM playlists WHERE id = ?').run(r.playlist_id)
  })
  tx()
  return true
}
