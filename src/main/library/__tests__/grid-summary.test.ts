import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { rowToTrack, LIST_COLUMNS, insertOrUpdateTrack } from '../db'
import { refreshGridSummary, backfillGridSummaries } from '../grid-summary'
import type { Beatgrid, TrackInput } from '../../../shared/types'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

const analysed = (source: string, medianBpm: number, confs: number[]): Beatgrid =>
  ({
    beats: confs.map((c, i) => ({ positionMs: i * 500, beatInBar: i % 4, confidence: c })),
    bars: [], downbeats: [], source, medianBpm, firstBeatMs: 0,
    isConstantTempo: true, computedAt: '2026-01-01T00:00:00Z'
  }) as unknown as Beatgrid

function seed(db: Database.Database, id: string, opts: {
  markers?: number
  analysed?: Beatgrid | null
} = {}): void {
  const grid = Array.from({ length: opts.markers ?? 0 }, (_, i) => ({ positionMs: i * 500, bpm: 120 }))
  db.prepare(
    `INSERT INTO tracks (id, file_path, title, date_added, beatgrid, analysed_beatgrid)
     VALUES (?, ?, ?, datetime('now'), ?, ?)`
  ).run(id, `/m/${id}.mp3`, id, JSON.stringify(grid), opts.analysed ? JSON.stringify(opts.analysed) : null)
  refreshGridSummary(db, id)
}

const listRow = (db: Database.Database, id: string): Record<string, unknown> =>
  db.prepare(`SELECT ${LIST_COLUMNS} FROM tracks WHERE id = ?`).get(id) as Record<string, unknown>

let db: Database.Database
beforeEach(() => { db = freshDb() })

describe('grid summaries', () => {
  it('derives marker count, source, median bpm and mean confidence', () => {
    seed(db, 'a', { markers: 3, analysed: analysed('beat-this', 128.5, [0.9, 0.7, 0.8]) })

    const t = rowToTrack(listRow(db, 'a'))

    expect(t.gridSummary.markers).toBe(3)
    expect(t.gridSummary.hasAnalysed).toBe(true)
    expect(t.gridSummary.analysedSource).toBe('beat-this')
    expect(t.gridSummary.analysedMedianBpm).toBeCloseTo(128.5)
    expect(t.gridSummary.analysedConfidence).toBeCloseTo(0.8, 5) // (0.9+0.7+0.8)/3
  })

  it('reports an empty grid as zero markers and no analysed grid', () => {
    seed(db, 'b')

    const t = rowToTrack(listRow(db, 'b'))

    expect(t.gridSummary.markers).toBe(0)
    expect(t.gridSummary.hasAnalysed).toBe(false)
    expect(t.gridSummary.analysedSource).toBeNull()
    expect(t.gridSummary.analysedConfidence).toBeNull()
  })

  it('omits the grids from the list payload but keeps the summary', () => {
    seed(db, 'c', { markers: 500, analysed: analysed('manual', 174, [1, 1]) })

    const row = listRow(db, 'c')
    // the point of the exercise: the heavy columns are not even selected
    expect(row.beatgrid).toBeUndefined()
    expect(row.analysed_beatgrid).toBeUndefined()

    const t = rowToTrack(row)
    expect(t.beatgrid).toEqual([])       // safe default, not undefined
    expect(t.analysedBeatgrid).toBeNull()
    expect(t.gridSummary.markers).toBe(500)
    expect(t.gridSummary.analysedSource).toBe('manual')
  })

  it('still returns real grids on a full row', () => {
    seed(db, 'd', { markers: 2, analysed: analysed('manual', 100, [0.5]) })

    const t = rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get('d') as Record<string, unknown>)

    expect(t.beatgrid).toHaveLength(2)
    expect(t.analysedBeatgrid?.source).toBe('manual')
    expect(t.gridSummary.hasAnalysed).toBe(true)
  })

  it('keeps the summary in step when a grid is replaced', () => {
    seed(db, 'e', { markers: 3, analysed: analysed('beat-this', 120, [0.4]) })

    db.prepare("UPDATE tracks SET beatgrid = ?, analysed_beatgrid = ? WHERE id = 'e'")
      .run(JSON.stringify([{ positionMs: 0, bpm: 90 }]), JSON.stringify(analysed('manual', 90, [1, 1])))
    refreshGridSummary(db, 'e')

    const t = rowToTrack(listRow(db, 'e'))
    expect(t.gridSummary.markers).toBe(1)
    expect(t.gridSummary.analysedSource).toBe('manual')
    expect(t.gridSummary.analysedMedianBpm).toBe(90)
    expect(t.gridSummary.analysedConfidence).toBeCloseTo(1)
  })

  it('backfills libraries written before the summary columns existed', () => {
    // Simulate an old row: grids present, summaries never computed.
    db.prepare(
      `INSERT INTO tracks (id, file_path, title, date_added, beatgrid, analysed_beatgrid)
       VALUES ('old', '/m/old.mp3', 'old', datetime('now'), ?, ?)`
    ).run(JSON.stringify([{ positionMs: 0, bpm: 128 }, { positionMs: 500, bpm: 128 }]),
          JSON.stringify(analysed('tags', 128, [0.6, 0.4])))
    expect((listRow(db, 'old') as { beatgrid_markers: number }).beatgrid_markers).toBe(0)

    const filled = backfillGridSummaries(db)

    expect(filled).toBe(1)
    const t = rowToTrack(listRow(db, 'old'))
    expect(t.gridSummary.markers).toBe(2)
    expect(t.gridSummary.analysedSource).toBe('tags')
    expect(t.gridSummary.analysedConfidence).toBeCloseTo(0.5)
    expect(backfillGridSummaries(db)).toBe(0) // idempotent
  })

  it('sets the marker count on import without a second write', () => {
    const track = {
      id: 't1', filePath: '/m/t1.mp3', title: 't', artist: '', album: '', genre: '',
      year: null, label: '', bpm: 128, key: null, durationSeconds: 100, rating: 0,
      color: '', energy: null, danceability: null, mood: null, playCount: 0,
      lastPlayedAt: null, dateAdded: '2026-01-01', updatedAt: null, comment: '',
      tags: [], customTags: {}, cuePoints: [],
      beatgrid: [{ positionMs: 0, bpm: 128 }, { positionMs: 468, bpm: 128 }],
      analysedBeatgrid: null, editLineage: null, sourceIds: {}, fileSize: null,
      fileType: null, sampleRate: null, bitDepth: null, gainDb: null, phrases: null,
      embedding: null, overviewPeaks: null
    } as unknown as TrackInput

    insertOrUpdateTrack(db, track)

    expect(rowToTrack(listRow(db, 't1')).gridSummary.markers).toBe(2)
  })

  it('survives malformed grid JSON without throwing', () => {
    db.prepare(
      `INSERT INTO tracks (id, file_path, title, date_added, beatgrid)
       VALUES ('bad', '/m/bad.mp3', 'bad', datetime('now'), 'not json')`
    ).run()

    expect(() => refreshGridSummary(db, 'bad')).not.toThrow()
  })
})
