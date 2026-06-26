/**
 * Engine DJ (Engine Library) import.
 *
 * Used by Pioneer standalone hardware (CDJ-TOUR1, XDJ-XZ, PRIME series)
 * and Algoriddim djay Pro via AlphaTheta OneLibrary.
 *
 * DB location:
 *   macOS:   ~/Music/Engine Library/Database2/m.db
 *   Windows: %USERPROFILE%\Music\Engine Library\Database2\m.db
 *   USB:     /ENGINELIBRARY/Database2/m.db
 */
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import type { Track, CuePoint, ImportResult } from '../../../shared/types'

export function getDefaultEngineDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(home, 'Music', 'Engine Library', 'Database2', 'm.db')
}

export function importFromIntegration(appDb: Database.Database, dbPath: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  let eng: Database.Database
  try {
    eng = new Database(dbPath, { readonly: true })
  } catch (err) {
    result.errors.push(`Cannot open Engine Library database: ${(err as Error).message}`)
    return result
  }

  try {
    const tracks = eng.prepare(`
      SELECT id, path, filename, title, artist, album, genre, comment,
             bpm, key, rating, length, bitrate, dateAdded, label, composer,
             year
      FROM Track
      WHERE path IS NOT NULL
    `).all() as Record<string, unknown>[]

    const insertTrack = appDb.transaction((track: Track) => insertOrUpdateTrack(appDb, track))

    for (const row of tracks) {
      try {
        const engId = String(row.id)
        const cues = getCuePoints(eng, engId)
        const filePath = resolveEnginePath(String(row.path ?? ''))

        const track: Track = {
          id: randomUUID(),
          filePath,
          title: String(row.title ?? row.filename ?? ''),
          artist: String(row.artist ?? ''),
          album: String(row.album ?? ''),
          genre: String(row.genre ?? ''),
          year: row.year != null ? Number(row.year) : null,
          label: String(row.label ?? ''),
          bpm: row.bpm != null ? Number(row.bpm) : null,
          key: engineKeyToName(row.key as number | null),
          durationSeconds: row.length != null ? Number(row.length) : null,
          rating: engineRatingToStars(row.rating as number | null),
          dateAdded: row.dateAdded ? String(row.dateAdded) : new Date().toISOString(),
          comment: String(row.comment ?? ''),
          tags: [],
          customTags: {},
          cuePoints: cues,
          beatgrid: [],
          energy: null,
          danceability: null,
          mood: null,
          analysedBeatgrid: null,
          editLineage: null,
          color: '',
          playCount: 0,
          lastPlayedAt: null,
          updatedAt: null,
          fileSize: null,
          fileType: null,
          sampleRate: null,
          bitDepth: null,
          gainDb: null,
          phrases: null,
          embedding: null, overviewPeaks: null,
          sourceIds: { 'engine-dj': engId }
        }

        insertTrack(track)
        result.tracksImported++
      } catch (err) {
        result.errors.push(`Track ${row.id}: ${(err as Error).message}`)
      }
    }

    // Import crates as playlists
    let crates: Record<string, unknown>[] = []
    try {
      crates = eng.prepare('SELECT id, title, path FROM Crate').all() as Record<string, unknown>[]
    } catch {
      // Crate table might not exist in all versions
    }

    for (let i = 0; i < crates.length; i++) {
      const crate = crates[i]
      const crateId = String(crate.id)
      const internalId = randomUUID()

      appDb.prepare(`
        INSERT OR REPLACE INTO playlists (id, name, is_folder, sort_order, source_ids)
        VALUES (?, ?, 0, ?, ?)
      `).run(internalId, String(crate.title ?? 'Untitled Crate'), i, JSON.stringify({ 'engine-dj': crateId }))

      let crateTrackRows: { trackId: string }[] = []
      try {
        crateTrackRows = eng.prepare(
          'SELECT trackId FROM CrateTrackList WHERE crateId = ? ORDER BY position'
        ).all(crateId) as { trackId: string }[]
      } catch { /* table name varies */ }

      for (let j = 0; j < crateTrackRows.length; j++) {
        const engTrackId = String(crateTrackRows[j].trackId)
        const internalTrack = appDb.prepare(
          `SELECT id FROM tracks WHERE json_extract(source_ids, '$."engine-dj"') = ?`
        ).get(engTrackId) as { id: string } | undefined

        if (internalTrack) {
          appDb.prepare(
            'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
          ).run(internalId, internalTrack.id, j)
        }
      }
      result.playlistsImported++
    }
  } finally {
    eng.close()
  }

  return result
}

export function exportToIntegration(appDb: Database.Database, dbPath: string): import('../../../shared/types').ExportResult {
  const result = { tracksExported: 0, playlistsExported: 0, errors: [] as string[], cancelled: false }

  // Engine DJ write-back: update existing tracks matched by path
  let eng: Database.Database
  try {
    eng = new Database(dbPath)
  } catch (err) {
    result.errors.push(`Cannot open Engine Library database: ${(err as Error).message}`)
    return result
  }

  try {
    const tracks = appDb.prepare(`
      SELECT * FROM tracks WHERE json_extract(source_ids, '$."engine-dj"') IS NOT NULL
    `).all() as Record<string, unknown>[]

    // NOTE: `key` is deliberately NOT written. The Engine key encoding
    // (Camelot 1-24 vs chromatic 0-23) is unverified against a real m.db — see
    // engineKeyToName/nameToEngineKey and scripts/inspect-engine-db.cjs.
    // Writing a guessed value could silently corrupt the key of a track whose
    // key originated from another source. We leave Engine's existing key value
    // untouched until the mapping is confirmed, then restore `key = ?` here.
    const updateStmt = eng.prepare(`
      UPDATE Track SET
        title = ?, artist = ?, album = ?, genre = ?, comment = ?,
        bpm = ?, rating = ?
      WHERE id = ?
    `)

    const update = eng.transaction(() => {
      for (const row of tracks) {
        const sourceIds = JSON.parse((row.source_ids as string) || '{}')
        const engId = sourceIds['engine-dj']
        if (!engId) continue
        updateStmt.run(
          row.title, row.artist, row.album, row.genre, row.comment,
          row.bpm,
          starsToEngineRating(row.rating as number),
          engId
        )
        result.tracksExported++
      }
    })
    update()
  } finally {
    eng.close()
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCuePoints(eng: Database.Database, trackId: string): CuePoint[] {
  try {
    const rows = eng.prepare(`
      SELECT id, type, startSample, endSample, color, name, sortIndex
      FROM PerformanceData
      WHERE trackId = ? AND type IN (0, 1, 2)
      ORDER BY sortIndex
    `).all(trackId) as Record<string, unknown>[]

    return rows.map((r, i): CuePoint => ({
      index: i,
      type: Number(r.type) === 2 ? 'loop' : 'hotcue',
      positionMs: sampleToMs(Number(r.startSample)),
      color: engineColorToHex(r.color as number | null),
      label: String(r.name ?? '')
    }))
  } catch {
    return []
  }
}

export function sampleToMs(sample: number, sampleRate = 44100): number {
  return Math.round((sample / sampleRate) * 1000)
}

function resolveEnginePath(p: string): string {
  if (!p) return ''
  // Engine DJ stores paths with a leading / on Mac, backslash on Windows
  return p.replace(/\\/g, '/')
}

export function engineKeyToName(key: number | null): string | null {
  if (key == null || key === 0) return null
  // Engine DJ uses Camelot: 1-12 = 1A-12A (minor), 13-24 = 1B-12B (major)
  const minor = ['1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A']
  const major = ['1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']
  if (key >= 1 && key <= 12) return minor[key - 1]
  if (key >= 13 && key <= 24) return major[key - 13]
  return null
}

export function nameToEngineKey(name: string | null): number | null {
  if (!name) return null
  const minor = ['1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A']
  const major = ['1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']
  const mi = minor.indexOf(name)
  if (mi >= 0) return mi + 1
  const ma = major.indexOf(name)
  if (ma >= 0) return ma + 13
  return null
}

export function engineRatingToStars(rating: number | null): number {
  if (!rating) return 0
  return Math.round((rating / 100) * 5)
}

export function starsToEngineRating(stars: number): number {
  return Math.round((stars / 5) * 100)
}

export function engineColorToHex(color: number | null): string {
  if (!color) return '#ff8c00'
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}
