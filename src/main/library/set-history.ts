// Set History — set-level metadata over is_history playlists.
//
// A played set's ordered tracks already live in an `is_history` playlist (from
// the Pioneer-USB importer or ProLink capture). This module adds the set-level
// layer: `set_sessions` rows with denormalised summary metrics (computed once),
// plus list/detail/update/delete. Backfill creates a session for every history
// playlist that doesn't have one yet, so existing history shows up immediately.

import { randomUUID } from 'crypto'
import { basename } from 'path'
import type { Database } from 'better-sqlite3'
import { readUsbHistory } from '../integrations/pioneer-usb/history-reader'
import type {
  SetDetail, SetListFilter, SetPatch, SetSummary, SetTrack, SetTransition, UsbHistoryPreview, UsbImportResult,
  Residency, ResidencyPatch, ResidencyRollup, RotationTrack, ResidencyDashboard, SetCompareSide, SetComparison
} from '../../shared/types'

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
  const clauses: string[] = []
  const params: unknown[] = []
  if (!filter.includeArchived) clauses.push("status != 'archived'")
  if (filter.residencyId) { clauses.push('residency_id = ?'); params.push(filter.residencyId) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM set_sessions ${where} ORDER BY (played_on IS NULL), played_on DESC, imported_at DESC`)
    .all(...params) as SessionRow[]
  return rows.map(toSummary)
}

function humanDur(sec: number): string {
  const m = Math.round(sec / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A coach's-note paragraph: the set's arc, mixing tightness and breadth. */
function buildDebrief(rows: PlTrackRow[], r: SessionRow, transitions: SetTransition[]): string {
  if (!rows.length) return 'No tracks recorded for this set.'
  const parts: string[] = []
  parts.push(`${rows.length} track${rows.length === 1 ? '' : 's'}${r.duration_sec ? ` over ${humanDur(r.duration_sec)}` : ''}.`)
  const first = rows.find((t) => t.bpm)?.bpm
  const last = [...rows].reverse().find((t) => t.bpm)?.bpm
  if (first && last) {
    const range = r.bpm_min != null && r.bpm_max != null ? ` (${Math.round(r.bpm_min)}–${Math.round(r.bpm_max)} range)` : ''
    parts.push(`Tempo ran ${Math.round(first)}→${Math.round(last)} BPM${range}.`)
  }
  if (r.energy_avg != null) parts.push(`Energy averaged ${r.energy_avg.toFixed(1)}/10.`)
  if (r.harmonic_pct != null && transitions.length) {
    const rough = transitions.filter((t) => t.harmonic === false || (t.bpmDelta != null && Math.abs(t.bpmDelta) > 8)).length
    parts.push(`${Math.round(r.harmonic_pct)}% harmonic mixing across ${transitions.length} transitions${rough ? `, with ${rough} rough cut${rough === 1 ? '' : 's'}` : ''}.`)
  }
  const keys = new Set(rows.map((t) => t.key).filter((k): k is string => !!k))
  if (keys.size) parts.push(`${keys.size} distinct key${keys.size === 1 ? '' : 's'}.`)
  return parts.join(' ')
}

/** Full set: summary + ordered running order + transition deltas + debrief. */
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
  return { ...toSummary(r), device: r.device, notes: r.notes, recordingPath: r.recording_path, tracks, transitions, debrief: buildDebrief(rows, r, transitions) }
}

/** Copy a set's tracks into a fresh regular playlist ("recreate a winning night"). */
export function recreateSetAsPlaylist(db: Database, setId: string): { playlistId: string; name: string } | null {
  const r = db.prepare('SELECT title, playlist_id FROM set_sessions WHERE id = ?').get(setId) as
    | { title: string; playlist_id: string | null }
    | undefined
  if (!r?.playlist_id) return null
  const tracks = db
    .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order')
    .all(r.playlist_id) as { track_id: string }[]
  const pid = randomUUID()
  const name = `${r.title} (recreated)`
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, name, sort_order) VALUES (?, ?, 0)').run(pid, name)
    const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
    tracks.forEach((t, i) => ins.run(pid, t.track_id, i))
  })
  tx()
  return { playlistId: pid, name }
}

const PATCH_COLS: Record<keyof SetPatch, string> = {
  title: 'title',
  venue: 'venue',
  rating: 'rating',
  vibe: 'vibe',
  notes: 'notes',
  status: 'status',
  residencyId: 'residency_id'
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

/** A stable dedupe key for a HISTORY on a stick: `HISTORY NNN@<volume>`. */
function historyRef(usbRoot: string, name: string): string {
  return `${name}@${basename(usbRoot) || 'usb'}`
}

/** Preview the HISTORY sets on a Pioneer stick, flagging already-imported ones.
 *  Throws if the stick has no rekordbox.db (caller surfaces the message). */
export function listUsbHistories(db: Database, usbRoot: string): UsbHistoryPreview[] {
  const seen = db.prepare('SELECT 1 FROM set_sessions WHERE history_ref = ?')
  return readUsbHistory(usbRoot, db).map((s) => {
    const ref = historyRef(usbRoot, s.name)
    return {
      ref,
      name: s.name,
      playedOn: s.date,
      trackCount: s.tracks.length,
      matchedCount: s.tracks.filter((t) => t.localTrackId).length,
      durationSec: s.tracks.reduce((a, t) => a + (t.durationSeconds || 0), 0) || null,
      alreadyImported: !!seen.get(ref)
    }
  })
}

/** Import the selected HISTORY sets off a stick: create an is_history playlist
 *  (resolved tracks only) + a set_sessions row per set. Skips already-imported
 *  refs (idempotent re-insert of the same stick). */
export function importUsbHistories(db: Database, usbRoot: string, refs: string[]): UsbImportResult {
  const device = basename(usbRoot) || 'usb'
  const wanted = new Set(refs)
  const sets = readUsbHistory(usbRoot, db)
  const seen = db.prepare('SELECT 1 FROM set_sessions WHERE history_ref = ?')
  const imported: UsbImportResult['imported'] = []
  const insPl = db.prepare("INSERT INTO playlists (id, name, sort_order, is_history) VALUES (?, ?, 0, 1)")
  const insPt = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
  const insSes = db.prepare(
    `INSERT INTO set_sessions
       (id, playlist_id, title, played_on, source, device, history_ref, track_count, duration_sec, avg_bpm, bpm_min, bpm_max, energy_avg, harmonic_pct)
     VALUES
       (@id, @pl, @title, @played, 'usb-history', @device, @ref, @tc, @dur, @avg, @min, @max, @en, @harm)`
  )
  const tx = db.transaction(() => {
    for (const s of sets) {
      const ref = historyRef(usbRoot, s.name)
      if (!wanted.has(ref) || seen.get(ref)) continue
      const matched = s.tracks.filter((t) => t.localTrackId)
      const plId = randomUUID()
      insPl.run(plId, s.name)
      matched.forEach((t, i) => insPt.run(plId, t.localTrackId, i))
      const sum = summarize(setTrackRows(db, plId))
      insSes.run({
        id: randomUUID(), pl: plId, title: s.name, played: s.date ?? null, device, ref,
        tc: sum.track_count, dur: sum.duration_sec, avg: sum.avg_bpm, min: sum.bpm_min,
        max: sum.bpm_max, en: sum.energy_avg, harm: sum.harmonic_pct
      })
      imported.push({ ref, name: s.name, trackCount: s.tracks.length, matchedCount: matched.length })
    }
  })
  tx()
  return { imported }
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

// ── Comparison ──────────────────────────────────────────────────────────────

function compareSide(db: Database, r: SessionRow): { side: SetCompareSide; ids: PlTrackRow[] } {
  const rows = r.playlist_id ? setTrackRows(db, r.playlist_id) : []
  const keys = new Set(rows.map((t) => t.key).filter((k): k is string => !!k))
  let rough = 0
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    const bpmJump = a.bpm != null && b.bpm != null && Math.abs(b.bpm - a.bpm) > 8
    if (bpmJump || (a.key && b.key && !camelotAdjacent(a.key, b.key))) rough++
  }
  const hours = r.duration_sec ? r.duration_sec / 3600 : 0
  return {
    side: {
      id: r.id,
      title: r.title,
      playedOn: r.played_on,
      trackCount: r.track_count ?? rows.length,
      durationSec: r.duration_sec,
      tracksPerHour: hours > 0 ? +(rows.length / hours).toFixed(1) : null,
      avgBpm: r.avg_bpm,
      bpmRange: r.bpm_min != null && r.bpm_max != null ? +(r.bpm_max - r.bpm_min).toFixed(1) : null,
      energyAvg: r.energy_avg,
      harmonicPct: r.harmonic_pct,
      keyDiversityPct: rows.length ? +((keys.size / rows.length) * 100).toFixed(0) : null,
      roughTransitions: rough
    },
    ids: rows
  }
}

/** Compare two sets: side-by-side metrics + the shared / unique-to-each split. */
export function compareSets(db: Database, aId: string, bId: string): SetComparison | null {
  const ra = db.prepare('SELECT * FROM set_sessions WHERE id = ?').get(aId) as SessionRow | undefined
  const rb = db.prepare('SELECT * FROM set_sessions WHERE id = ?').get(bId) as SessionRow | undefined
  if (!ra || !rb) return null
  const a = compareSide(db, ra)
  const b = compareSide(db, rb)
  const meta = (t: PlTrackRow): { trackId: string; title: string; artist: string } =>
    ({ trackId: t.track_id, title: t.title, artist: t.artist })
  const aIds = new Set(a.ids.map((t) => t.track_id))
  const bIds = new Set(b.ids.map((t) => t.track_id))
  return {
    a: a.side,
    b: b.side,
    shared: a.ids.filter((t) => bIds.has(t.track_id)).map(meta),
    onlyA: a.ids.filter((t) => !bIds.has(t.track_id)).map(meta),
    onlyB: b.ids.filter((t) => !aIds.has(t.track_id)).map(meta)
  }
}

// ── Residencies ─────────────────────────────────────────────────────────────

interface ResidencyRow {
  id: string
  name: string
  venue: string
  color: string
  cadence: string | null
  notes: string | null
}

export function listResidencies(db: Database): Residency[] {
  const rows = db.prepare('SELECT * FROM residencies ORDER BY name').all() as ResidencyRow[]
  const count = db.prepare("SELECT COUNT(*) c FROM set_sessions WHERE residency_id = ? AND status != 'archived'")
  return rows.map((r) => ({ ...r, setCount: (count.get(r.id) as { c: number }).c }))
}

export function createResidency(db: Database, patch: ResidencyPatch): Residency {
  const id = randomUUID()
  db.prepare('INSERT INTO residencies (id, name, venue, color) VALUES (?, ?, ?, ?)').run(
    id, patch.name?.trim() || 'Residency', patch.venue ?? '', patch.color || '#8A8474'
  )
  if (patch.cadence !== undefined || patch.notes !== undefined) updateResidency(db, id, patch)
  return { id, name: patch.name?.trim() || 'Residency', venue: patch.venue ?? '', color: patch.color || '#8A8474', cadence: patch.cadence ?? null, notes: patch.notes ?? null, setCount: 0 }
}

const RES_COLS: Record<keyof ResidencyPatch, string> = {
  name: 'name', venue: 'venue', color: 'color', cadence: 'cadence', notes: 'notes'
}
export function updateResidency(db: Database, id: string, patch: ResidencyPatch): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [k, col] of Object.entries(RES_COLS) as [keyof ResidencyPatch, string][]) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); values.push(patch[k]) }
  }
  if (!sets.length) return
  values.push(id)
  db.prepare(`UPDATE residencies SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

/** Delete a residency. Its sets survive (FK sets residency_id → NULL). */
export function deleteResidency(db: Database, id: string): void {
  db.prepare('DELETE FROM residencies WHERE id = ?').run(id)
}

/** Residency dashboard: rolling-average baseline + rotation tracker over its
 *  sets (newest first), so over-rotation and rested gems are visible. */
export function residencyDashboard(db: Database, id: string): ResidencyDashboard | null {
  const row = db.prepare('SELECT * FROM residencies WHERE id = ?').get(id) as ResidencyRow | undefined
  if (!row) return null
  const sets = db
    .prepare("SELECT * FROM set_sessions WHERE residency_id = ? AND status != 'archived' ORDER BY (played_on IS NULL), played_on DESC, imported_at DESC")
    .all(id) as SessionRow[]
  const setCount = sets.length

  const avg = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => typeof x === 'number')
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const played = sets.map((s) => s.played_on).filter((p): p is string => !!p)
  const rollup: ResidencyRollup = {
    setCount,
    avgBpm: avg(sets.map((s) => s.avg_bpm)),
    avgTrackCount: avg(sets.map((s) => s.track_count)),
    avgDurationSec: avg(sets.map((s) => s.duration_sec)),
    avgHarmonicPct: avg(sets.map((s) => s.harmonic_pct)),
    firstPlayedOn: played.length ? played[played.length - 1] : null,
    lastPlayedOn: played.length ? played[0] : null
  }

  // Rotation: track ordered membership across sets (index 0 = newest set).
  const memberRows = db.prepare(
    'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order'
  )
  const setTrackSets = sets.map((s) =>
    s.playlist_id ? new Set((memberRows.all(s.playlist_id) as { track_id: string }[]).map((r) => r.track_id)) : new Set<string>()
  )
  const tally = new Map<string, { plays: number; lastAgo: number; streak: number }>()
  setTrackSets.forEach((trackSet, idx) => {
    for (const tid of trackSet) {
      const e = tally.get(tid) ?? { plays: 0, lastAgo: idx, streak: 0 }
      e.plays++
      tally.set(tid, e)
    }
  })
  // streak = consecutive sets from the newest (idx 0) that contain the track.
  for (const [tid, e] of tally) {
    let s = 0
    while (s < setTrackSets.length && setTrackSets[s].has(tid)) s++
    e.streak = s
    e.lastAgo = setTrackSets.findIndex((ts) => ts.has(tid))
  }
  const ids = [...tally.keys()]
  const meta = new Map<string, { title: string; artist: string }>()
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT id, title, artist FROM tracks WHERE id IN (${placeholders})`).all(...ids) as { id: string; title: string; artist: string }[]
    for (const r of rows) meta.set(r.id, { title: r.title, artist: r.artist })
  }
  const rotation: RotationTrack[] = ids
    .map((tid) => ({ trackId: tid, title: meta.get(tid)?.title ?? '(unknown)', artist: meta.get(tid)?.artist ?? '', ...tally.get(tid)! }))
    .filter((t) => t.plays > 1) // a record is only "rotation" once it repeats
    .sort((a, b) => b.plays - a.plays || b.streak - a.streak)
    .slice(0, 40)

  return { residency: { ...row, setCount }, rollup, rotation }
}
