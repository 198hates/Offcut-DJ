import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { mergeDuplicateInto } from '../merge-duplicate'

interface Seed {
  id: string
  path: string
  title?: string
  artist?: string
  bpm?: number | null
  key?: string | null
  rating?: number
  playCount?: number
  comment?: string
  cues?: string
  tags?: string
  color?: string
  energy?: number | null
  lastPlayed?: string | null
  beatgrid?: string
  analysedGrid?: string
}

function insert(db: Database.Database, t: Seed): void {
  db.prepare(
    `INSERT INTO tracks (id, file_path, title, artist, bpm, key, date_added, rating, play_count,
       comment, cue_points, tags, color, energy, last_played_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id, t.path, t.title ?? '', t.artist ?? '', t.bpm ?? null, t.key ?? null,
    t.rating ?? 0, t.playCount ?? 0, t.comment ?? '', t.cues ?? '[]', t.tags ?? '[]',
    t.color ?? '', t.energy ?? null, t.lastPlayed ?? null
  )
  if (t.beatgrid || t.analysedGrid) {
    db.prepare(
      'INSERT INTO track_grids (track_id, beatgrid, analysed_beatgrid) VALUES (?, ?, ?)'
    ).run(t.id, t.beatgrid ?? '[]', t.analysedGrid ?? null)
  }
}

const row = (db: Database.Database, id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as Record<string, unknown>

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
})

describe('mergeDuplicateInto', () => {
  it('fills fields the keeper is missing from the loser', () => {
    // The realistic case: an old cued+rated copy, and a clean re-download kept
    // because it is the better file.
    insert(db, { id: 'old', path: '/m/old.mp3', cues: '[{"pos":1}]', rating: 4, comment: 'peak time', tags: '["dark"]', energy: 8 })
    insert(db, { id: 'new', path: '/m/new.aiff', bpm: 128, key: '8A' })

    const res = mergeDuplicateInto(db, 'old', 'new')

    const keeper = row(db, 'new')
    expect(keeper.cue_points).toBe('[{"pos":1}]')
    expect(keeper.comment).toBe('peak time')
    expect(keeper.tags).toBe('["dark"]')
    expect(keeper.energy).toBe(8)
    expect(keeper.rating).toBe(4)
    expect(res.fieldsFilled).toEqual(expect.arrayContaining(['cue_points', 'comment', 'tags', 'energy']))
    expect(res.ratingRaised).toBe(true)
  })

  it("never overwrites a value the keeper already has", () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', comment: 'loser note', bpm: 100, cues: '[{"pos":9}]', rating: 5 })
    insert(db, { id: 'keeper', path: '/m/k.mp3', comment: 'keeper note', bpm: 128, cues: '[{"pos":1}]', rating: 2 })

    mergeDuplicateInto(db, 'loser', 'keeper')

    const keeper = row(db, 'keeper')
    expect(keeper.comment).toBe('keeper note')
    expect(keeper.bpm).toBe(128)
    expect(keeper.cue_points).toBe('[{"pos":1}]')
    // rating is the exception: it takes the higher of the two, not the keeper's.
    expect(keeper.rating).toBe(5)
  })

  it('leaves the loser untouched so a later failure cannot lose both copies', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', cues: '[{"pos":9}]', rating: 5 })
    insert(db, { id: 'keeper', path: '/m/k.mp3' })

    mergeDuplicateInto(db, 'loser', 'keeper')

    const loser = row(db, 'loser')
    expect(loser).toBeDefined()
    expect(loser.cue_points).toBe('[{"pos":9}]')
    expect(loser.rating).toBe(5)
  })

  it('claims a beatgrid the keeper does not have', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', beatgrid: '[{"t":0.5,"bpm":128}]', analysedGrid: '[{"t":0.5}]' })
    insert(db, { id: 'keeper', path: '/m/k.mp3' })

    const res = mergeDuplicateInto(db, 'loser', 'keeper')

    expect(res.gridClaimed).toBe(true)
    const grid = db.prepare('SELECT beatgrid FROM track_grids WHERE track_id = ?').get('keeper') as { beatgrid: string }
    expect(grid.beatgrid).toBe('[{"t":0.5,"bpm":128}]')
    // The summary columns the library list reads must follow the grid across.
    expect(row(db, 'keeper').beatgrid_markers).toBe(1)
  })

  it("does not overwrite the keeper's own beatgrid", () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', beatgrid: '[{"t":9}]' })
    insert(db, { id: 'keeper', path: '/m/k.mp3', beatgrid: '[{"t":1}]' })

    const res = mergeDuplicateInto(db, 'loser', 'keeper')

    expect(res.gridClaimed).toBe(false)
    const grid = db.prepare('SELECT beatgrid FROM track_grids WHERE track_id = ?').get('keeper') as { beatgrid: string }
    expect(grid.beatgrid).toBe('[{"t":1}]')
  })

  it('treats an empty grid placeholder as no grid', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', beatgrid: '[{"t":9}]' })
    insert(db, { id: 'keeper', path: '/m/k.mp3', beatgrid: '[]' })

    expect(mergeDuplicateInto(db, 'loser', 'keeper').gridClaimed).toBe(true)
  })

  it('moves playlist entries and drops ones the keeper already has', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3' })
    insert(db, { id: 'keeper', path: '/m/k.mp3' })
    db.prepare("INSERT INTO playlists (id, name) VALUES ('p1','One'), ('p2','Both')").run()
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p1', 'loser', 3)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p2', 'loser', 1)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?,?,?)').run('p2', 'keeper', 2)

    const res = mergeDuplicateInto(db, 'loser', 'keeper')

    expect(res.playlistRefsMoved).toBe(1)
    const ids = (pid: string): string[] =>
      (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY track_id').all(pid) as { track_id: string }[])
        .map((r) => r.track_id)
    expect(ids('p1')).toEqual(['keeper'])
    expect(ids('p2')).toEqual(['keeper'])
    // The moved entry keeps its slot in the playlist.
    const moved = db.prepare('SELECT sort_order FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get('p1', 'keeper') as { sort_order: number }
    expect(moved.sort_order).toBe(3)
  })

  it('repoints play history and takes the later last-played date', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', playCount: 7, lastPlayed: '2026-05-01 12:00:00' })
    insert(db, { id: 'keeper', path: '/m/k.mp3', playCount: 2, lastPlayed: '2026-01-01 12:00:00' })
    db.prepare("INSERT INTO play_history (id, track_id, played_at) VALUES ('h1','loser','2026-05-01 12:00:00')").run()

    const res = mergeDuplicateInto(db, 'loser', 'keeper')

    expect(res.playHistoryRepointed).toBe(1)
    expect(res.playCountRaised).toBe(true)
    const keeper = row(db, 'keeper')
    expect(keeper.play_count).toBe(7)
    expect(keeper.last_played_at).toBe('2026-05-01 12:00:00')
    const h = db.prepare('SELECT track_id FROM play_history WHERE id = ?').get('h1') as { track_id: string }
    expect(h.track_id).toBe('keeper')
  })

  it('survives the delete that follows it — nothing the keeper claimed cascades away', () => {
    insert(db, { id: 'loser', path: '/m/l.mp3', cues: '[{"pos":1}]', beatgrid: '[{"t":1}]' })
    insert(db, { id: 'keeper', path: '/m/k.mp3' })
    db.prepare("INSERT INTO playlists (id, name) VALUES ('p1','One')").run()
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (?,?)').run('p1', 'loser')

    mergeDuplicateInto(db, 'loser', 'keeper')
    db.prepare('DELETE FROM tracks WHERE id = ?').run('loser')

    expect(row(db, 'keeper').cue_points).toBe('[{"pos":1}]')
    const grid = db.prepare('SELECT beatgrid FROM track_grids WHERE track_id = ?').get('keeper') as { beatgrid: string }
    expect(grid.beatgrid).toBe('[{"t":1}]')
    const entries = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all('p1') as { track_id: string }[]
    expect(entries).toEqual([{ track_id: 'keeper' }])
  })

  it('does nothing for a missing row or a self-merge', () => {
    insert(db, { id: 'keeper', path: '/m/k.mp3' })

    expect(mergeDuplicateInto(db, 'ghost', 'keeper').fieldsFilled).toEqual([])
    expect(mergeDuplicateInto(db, 'keeper', 'ghost').fieldsFilled).toEqual([])
    expect(mergeDuplicateInto(db, 'keeper', 'keeper').fieldsFilled).toEqual([])
  })

  it('does not claim the source ids of the removed copy', () => {
    // Claiming them would silently repoint the rekordbox export at another row.
    insert(db, { id: 'loser', path: '/m/l.mp3' })
    db.prepare(`UPDATE tracks SET source_ids = '{"rekordbox":"999"}' WHERE id = 'loser'`).run()
    insert(db, { id: 'keeper', path: '/m/k.mp3' })

    mergeDuplicateInto(db, 'loser', 'keeper')

    expect(row(db, 'keeper').source_ids).toBe('{}')
  })
})
