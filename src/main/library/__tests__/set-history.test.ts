import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { camelotAdjacent, backfillSetSessions, listSets, getSet, updateSet, deleteSet, createResidency, residencyDashboard, compareSets, recreateSetAsPlaylist } from '../set-history'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

let n = 0
function track(db: Database.Database, fields: { bpm?: number; key?: string; energy?: number; dur?: number }): string {
  const id = `t${++n}`
  db.prepare(
    "INSERT INTO tracks (id, file_path, title, date_added, bpm, key, energy, duration_seconds) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)"
  ).run(id, `/m/${id}.mp3`, id, fields.bpm ?? null, fields.key ?? null, fields.energy ?? null, fields.dur ?? null)
  return id
}

function historyPlaylist(db: Database.Database, name: string, trackIds: string[]): string {
  const id = `pl-${name}`
  db.prepare("INSERT INTO playlists (id, name, sort_order, is_history) VALUES (?, ?, 0, 1)").run(id, name)
  const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
  trackIds.forEach((tid, i) => ins.run(id, tid, i))
  return id
}

describe('camelotAdjacent', () => {
  it('matches same key, ±1 hour (incl. 12↔1 wrap), and relative major/minor', () => {
    expect(camelotAdjacent('8A', '8A')).toBe(true)
    expect(camelotAdjacent('8A', '9A')).toBe(true)
    expect(camelotAdjacent('12A', '1A')).toBe(true)
    expect(camelotAdjacent('8A', '8B')).toBe(true) // relative
    expect(camelotAdjacent('8A', '10A')).toBe(false)
    expect(camelotAdjacent('8A', '3B')).toBe(false)
    expect(camelotAdjacent(null, '8A')).toBe(false)
  })
})

describe('set history', () => {
  it('backfills a session per history playlist with computed summary metrics', () => {
    const db = freshDb()
    const a = track(db, { bpm: 120, key: '8A', energy: 5, dur: 300 })
    const b = track(db, { bpm: 124, key: '9A', energy: 7, dur: 360 }) // harmonic with a
    const c = track(db, { bpm: 128, key: '2A', energy: 9, dur: 300 }) // NOT harmonic with b
    historyPlaylist(db, 'HISTORY 014 2026-05-17', [a, b, c])

    const made = backfillSetSessions(db)
    expect(made).toBe(1)
    // idempotent
    expect(backfillSetSessions(db)).toBe(0)

    const sets = listSets(db)
    expect(sets).toHaveLength(1)
    const s = sets[0]
    expect(s.playedOn).toBe('2026-05-17') // parsed from the name
    expect(s.trackCount).toBe(3)
    expect(s.durationSec).toBe(960)
    expect(s.avgBpm).toBeCloseTo(124, 5)
    expect(s.bpmMin).toBe(120)
    expect(s.bpmMax).toBe(128)
    expect(s.energyAvg).toBeCloseTo(7, 5)
    expect(s.harmonicPct).toBeCloseTo(50, 5) // 1 of 2 transitions harmonic
  })

  it('get returns ordered tracks + transition deltas; update + archive + delete work', () => {
    const db = freshDb()
    const a = track(db, { bpm: 120, key: '8A' })
    const b = track(db, { bpm: 126, key: '9A' })
    historyPlaylist(db, 'Set one', [a, b])
    const [s] = listSets(db)

    const detail = getSet(db, s.id)!
    expect(detail.tracks.map((t) => t.trackId)).toEqual([a, b])
    expect(detail.transitions).toHaveLength(1)
    expect(detail.transitions[0]).toMatchObject({ index: 1, bpmDelta: 6, harmonic: true })

    updateSet(db, s.id, { rating: 4, venue: 'The Cause', notes: 'peak' })
    expect(getSet(db, s.id)).toMatchObject({ rating: 4, venue: 'The Cause', notes: 'peak' })

    // archive hides from the default list but keeps the row
    updateSet(db, s.id, { status: 'archived' })
    expect(listSets(db)).toHaveLength(0)
    expect(listSets(db, { includeArchived: true })).toHaveLength(1)

    // delete removes the session AND its history playlist (no resurrection)
    expect(deleteSet(db, s.id)).toBe(true)
    expect(listSets(db, { includeArchived: true })).toHaveLength(0)
    expect(db.prepare('SELECT count(*) c FROM playlists').get()).toMatchObject({ c: 0 })
  })

  it('residency dashboard: rolling averages + rotation streaks', () => {
    const db = freshDb()
    const x = track(db, { bpm: 120 })
    const y = track(db, { bpm: 124 })
    const z = track(db, { bpm: 128 })
    historyPlaylist(db, 'Cause 2026-06-14', [x, z]) // newest: X, Z
    historyPlaylist(db, 'Cause 2026-06-07', [x, y]) // mid: X, Y
    historyPlaylist(db, 'Cause 2026-05-31', [x, y]) // oldest: X, Y
    const sets = listSets(db)
    const res = createResidency(db, { name: 'The Cause', color: '#B07A4E' })
    for (const s of sets) updateSet(db, s.id, { residencyId: res.id })

    const dash = residencyDashboard(db, res.id)!
    expect(dash.rollup.setCount).toBe(3)
    expect(dash.rollup.firstPlayedOn).toBe('2026-05-31')
    expect(dash.rollup.lastPlayedOn).toBe('2026-06-14')

    const byId = new Map(dash.rotation.map((r) => [r.trackId, r]))
    // X is in all three, consecutively from the newest → plays 3, streak 3, lastAgo 0
    expect(byId.get(x)).toMatchObject({ plays: 3, streak: 3, lastAgo: 0 })
    // Y is in the two oldest (not the newest) → plays 2, streak 0, lastAgo 1
    expect(byId.get(y)).toMatchObject({ plays: 2, streak: 0, lastAgo: 1 })
    // Z played once → below the rotation threshold (plays > 1)
    expect(byId.has(z)).toBe(false)
  })

  it('compareSets: side metrics + shared/unique split', () => {
    const db = freshDb()
    const x = track(db, { bpm: 120, key: '8A', dur: 600 })
    const y = track(db, { bpm: 126, key: '9A', dur: 600 }) // harmonic w/ x
    const z = track(db, { bpm: 140, key: '2A', dur: 600 }) // bpm jump + non-harmonic w/ y → rough
    const w = track(db, { bpm: 122, key: '8A', dur: 600 })
    historyPlaylist(db, 'A 2026-06-14', [x, y, z])
    historyPlaylist(db, 'B 2026-06-07', [x, w])
    const [a, b] = listSets(db) // newest first → A, B

    const cmp = compareSets(db, a.id, b.id)!
    expect(cmp.a.trackCount).toBe(3)
    expect(cmp.a.tracksPerHour).toBe(6) // 3 tracks / 0.5h
    expect(cmp.a.keyDiversityPct).toBe(100) // 3 distinct keys / 3
    expect(cmp.a.roughTransitions).toBe(1) // y→z
    expect(cmp.b.roughTransitions).toBe(0) // x→w harmonic, bpm jump 2
    expect(cmp.shared.map((t) => t.trackId)).toEqual([x])
    expect(cmp.onlyA.map((t) => t.trackId).sort()).toEqual([y, z].sort())
    expect(cmp.onlyB.map((t) => t.trackId)).toEqual([w])
  })

  it('getSet builds a debrief, and recreate copies the set into a fresh playlist', () => {
    const db = freshDb()
    const a = track(db, { bpm: 120, key: '8A', dur: 600 })
    const b = track(db, { bpm: 128, key: '9A', dur: 600 })
    historyPlaylist(db, 'Gig 2026-06-14', [a, b])
    const [s] = listSets(db)

    const detail = getSet(db, s.id)!
    expect(detail.debrief).toMatch(/2 tracks/)
    expect(detail.debrief).toMatch(/120→128 BPM/)

    const made = recreateSetAsPlaylist(db, s.id)!
    expect(made.name).toBe('Gig 2026-06-14 (recreated)')
    const pl = db.prepare('SELECT is_history FROM playlists WHERE id = ?').get(made.playlistId) as { is_history: number }
    expect(pl.is_history).toBe(0) // a normal, editable playlist
    const tids = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order').all(made.playlistId) as { track_id: string }[]
    expect(tids.map((t) => t.track_id)).toEqual([a, b])
  })
})
