/**
 * Rekordbox 6/7 direct database access via SQLCipher.
 *
 * The encryption key is the same across all Rekordbox 6/7 installations and is
 * publicly documented: pyrekordbox.readthedocs.io/en/latest/formats/db6.html
 *
 * DB location:
 *   macOS:   ~/Library/Pioneer/rekordbox/master.db
 *   Windows: %AppData%\Pioneer\rekordbox\master.db
 *
 * Requires: better-sqlite3-multiple-ciphers (compiled for Electron — run
 *   node scripts/rebuild-sqlcipher.js after npm install)
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import SqlCipherDatabase from 'better-sqlite3-multiple-ciphers'
import { rowToTrack, insertOrUpdateTrack } from '../../library/db'
import type { Track, CuePoint, ImportResult, ExportResult } from '../../../shared/types'

export const RB_KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'

export function getDefaultRekordboxDbPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? '', 'Pioneer', 'rekordbox', 'master.db')
  }
  return join(process.env.HOME ?? '', 'Library', 'Pioneer', 'rekordbox', 'master.db')
}

export function isRekordboxDbAvailable(dbPath?: string): boolean {
  const path = dbPath ?? getDefaultRekordboxDbPath()
  return existsSync(path)
}

// ── Cipher negotiation ───────────────────────────────────────────────────────
// Tries every known SQLCipher opening sequence. Logs results to the terminal.
// Returns an open, verified database or null.

// Each attempt uses exec() (sqlite3_exec) rather than pragma() (sqlite3_prepare_v2)
// because SQLCipher key pragmas must be executed via sqlite3_exec before page reads.
const CIPHER_ATTEMPTS: { label: string; setup: (db: InstanceType<typeof SqlCipherDatabase>) => void }[] = [
  // exec() path — bypasses better-sqlite3's prepared-statement layer
  { label: 'exec: sqlcipher+legacy4+hexkey',      setup: (db) => db.exec(`PRAGMA cipher='sqlcipher'; PRAGMA legacy=4; PRAGMA hexkey="${RB_KEY}"`) },
  { label: 'exec: compat4+hexkey',                setup: (db) => db.exec(`PRAGMA cipher_compatibility=4; PRAGMA hexkey="${RB_KEY}"`) },
  { label: "exec: sqlcipher+legacy4+key-x",       setup: (db) => db.exec(`PRAGMA cipher='sqlcipher'; PRAGMA legacy=4; PRAGMA key="x'${RB_KEY}'"`) },
  { label: "exec: compat4+key-x",                 setup: (db) => db.exec(`PRAGMA cipher_compatibility=4; PRAGMA key="x'${RB_KEY}'"`) },
  { label: "exec: key-x only",                    setup: (db) => db.exec(`PRAGMA key="x'${RB_KEY}'"`) },
  { label: 'exec: sqlcipher+legacy3+hexkey',      setup: (db) => db.exec(`PRAGMA cipher='sqlcipher'; PRAGMA legacy=3; PRAGMA hexkey="${RB_KEY}"`) },
  // pragma() path — uses prepared statements
  { label: 'pragma: sqlcipher+legacy4+hexkey',    setup: (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.pragma(`hexkey="${RB_KEY}"`) } },
  { label: 'pragma: compat4+hexkey',              setup: (db) => { db.pragma('cipher_compatibility=4'); db.pragma(`hexkey="${RB_KEY}"`) } },
  { label: "pragma: sqlcipher+legacy4+key-x",     setup: (db) => { db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.pragma(`key="x'${RB_KEY}'"`) } },
]

function openRekordboxDb(
  masterDbPath: string,
  readonly: boolean
): InstanceType<typeof SqlCipherDatabase> | null {
  // Write to a log file because Electron child process stdout isn't always captured
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { appendFileSync } = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path') as typeof import('path')
  const logPath = join(tmpdir(), 'crate-rekordbox.log')
  const log = (msg: string): void => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    process.stdout.write(line)
    try { appendFileSync(logPath, line) } catch { /* ignore */ }
  }

  log(`Trying to open: ${masterDbPath}`)

  for (const attempt of CIPHER_ATTEMPTS) {
    let db: InstanceType<typeof SqlCipherDatabase> | null = null
    try {
      db = new SqlCipherDatabase(masterDbPath, { readonly })
      attempt.setup(db)
      const row = db.prepare('SELECT COUNT(*) as c FROM djmdContent').get() as { c: number }
      log(`SUCCESS with "${attempt.label}" — ${row.c} tracks`)
      return db
    } catch (err) {
      log(`FAIL "${attempt.label}" → ${(err as Error).message}`)
      try { db?.close() } catch { /* ignore */ }
    }
  }
  log(`All attempts failed. Full log at: ${logPath}`)
  return null
}

// ── Import (Rekordbox → Internal library) ────────────────────────────────────

export function importFromRekordboxDb(
  appDb: Database.Database,
  masterDbPath: string
): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  const rb = openRekordboxDb(masterDbPath, true)
  if (!rb) {
    result.errors.push('Cannot open Rekordbox database: no cipher sequence worked — see terminal for details')
    return result
  }

  try {
    const tracks = rb
      .prepare(`
        SELECT c.ID, c.FolderPath, c.Title, c.ArtistName, c.AlbumName, c.GenreName,
               c.BPM, c.Tonality, c.StockDate, c.Rating, c.Commnt, c.Length,
               c.ColorID
        FROM djmdContent c
        WHERE c.FolderPath IS NOT NULL AND c.FolderPath != ''
      `)
      .all() as Record<string, unknown>[]

    const insertTrack = appDb.transaction((track: Track) => insertOrUpdateTrack(appDb, track))

    for (const row of tracks) {
      try {
        const rbId = String(row.ID)
        const cues = rb
          .prepare(`
            SELECT InMsec, Kind, Hot, Color, Comment
            FROM djmdCue
            WHERE ContentID = ?
            ORDER BY CASE WHEN Hot IS NOT NULL THEN 0 ELSE 1 END, InMsec
          `)
          .all(rbId) as Record<string, unknown>[]

        const track: Track = {
          id: randomUUID(),
          filePath: decodeRbPath(String(row.FolderPath ?? '')),
          title: String(row.Title ?? ''),
          artist: String(row.ArtistName ?? ''),
          album: String(row.AlbumName ?? ''),
          genre: String(row.GenreName ?? ''),
          bpm: row.BPM != null ? Number(row.BPM) / 100 : null,
          key: rbKeyToName(row.Tonality as string | null),
          durationSeconds: row.Length != null ? Number(row.Length) : null,
          rating: rbRatingToStars(row.Rating as number | null),
          dateAdded: String(row.StockDate ?? new Date().toISOString()),
          comment: String(row.Commnt ?? ''),
          tags: [],
          cuePoints: cues.map((c, i) => rbCueToPoint(c, i)),
          beatgrid: [],
          sourceIds: { rekordbox: rbId }
        }

        insertTrack(track)
        result.tracksImported++
      } catch (err) {
        result.errors.push(`Track ${row.ID}: ${(err as Error).message}`)
      }
    }

    const playlists = rb
      .prepare(`
        SELECT p.ID, p.Name, p.ParentID, p.Attribute, p.Seq
        FROM djmdPlaylist p
        WHERE p.Name IS NOT NULL
        ORDER BY p.Seq
      `)
      .all() as Record<string, unknown>[]

    const rbPlaylistIdToInternal = new Map<string, string>()

    for (let i = 0; i < playlists.length; i++) {
      const pl = playlists[i]
      const rbPlId = String(pl.ID)
      const internalId = randomUUID()
      rbPlaylistIdToInternal.set(rbPlId, internalId)

      const isFolder = Number(pl.Attribute) === 1
      const parentId = pl.ParentID
        ? rbPlaylistIdToInternal.get(String(pl.ParentID)) ?? null
        : null

      appDb.prepare(`
        INSERT OR REPLACE INTO playlists (id, name, is_folder, parent_id, sort_order, source_ids)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(internalId, String(pl.Name), isFolder ? 1 : 0, parentId, i, JSON.stringify({ rekordbox: rbPlId }))

      if (!isFolder) {
        const songs = rb
          .prepare('SELECT ContentID, TrackNo FROM djmdSongPlaylist WHERE PlaylistID = ? ORDER BY TrackNo')
          .all(rbPlId) as { ContentID: string; TrackNo: number }[]

        for (const song of songs) {
          const trackRow = appDb
            .prepare(`SELECT id FROM tracks WHERE json_extract(source_ids, '$.rekordbox') = ?`)
            .get(String(song.ContentID)) as { id: string } | undefined

          if (trackRow) {
            appDb.prepare(
              'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
            ).run(internalId, trackRow.id, song.TrackNo)
          }
        }
        result.playlistsImported++
      }
    }
  } finally {
    rb.close()
  }

  return result
}

// ── Export / Sync (Internal library → Rekordbox) ─────────────────────────────
// Writes metadata back to master.db. Rekordbox MUST be closed before calling.

export function exportToRekordboxDb(
  appDb: Database.Database,
  masterDbPath: string
): ExportResult {
  const result: ExportResult = { tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false }

  let rb: InstanceType<typeof SqlCipherDatabase>
  try {
    const rbW = openRekordboxDb(masterDbPath, false)
    if (!rbW) throw new Error('no cipher sequence worked — see terminal for details')
    rb = rbW
    rb.pragma('journal_mode = WAL')
    rb.pragma('foreign_keys = ON')
  } catch (err) {
    result.errors.push(`Cannot open Rekordbox database for writing: ${(err as Error).message}`)
    return result
  }

  try {
    const tracks = appDb
      .prepare(`
        SELECT * FROM tracks
        WHERE json_extract(source_ids, '$.rekordbox') IS NOT NULL
      `)
      .all() as Record<string, unknown>[]

    const updateTrack = rb.transaction((track: Track, rbId: string) => {
      rb.prepare(`
        UPDATE djmdContent SET
          Title = ?,
          ArtistName = ?,
          AlbumName = ?,
          GenreName = ?,
          BPM = ?,
          Tonality = ?,
          Rating = ?,
          Commnt = ?,
          updated_at = datetime('now')
        WHERE ID = ?
      `).run(
        track.title,
        track.artist,
        track.album,
        track.genre,
        track.bpm != null ? Math.round(track.bpm * 100) : null,
        track.key ?? null,
        starsToRbRating(track.rating),
        track.comment,
        rbId
      )

      if (track.cuePoints.length > 0) {
        rb.prepare('DELETE FROM djmdCue WHERE ContentID = ?').run(rbId)
        const insertCue = rb.prepare(`
          INSERT INTO djmdCue (ContentID, InMsec, Kind, Hot, Color, Comment, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `)
        for (const cue of track.cuePoints) {
          insertCue.run(
            rbId,
            cue.positionMs,
            cue.type === 'loop' ? 4 : cue.type === 'hotcue' ? 0 : 1,
            cue.type === 'hotcue' ? cue.index : null,
            hexToRbColor(cue.color),
            cue.label
          )
        }
      }
    })

    for (const row of tracks) {
      try {
        const track = rowToTrack(row)
        const rbId = String((track.sourceIds as Record<string, string>).rekordbox)
        updateTrack(track, rbId)
        result.tracksExported++
      } catch (err) {
        result.errors.push(`Track sync error: ${(err as Error).message}`)
      }
    }
  } finally {
    rb.close()
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeRbPath(path: string): string {
  // Rekordbox stores paths without URL encoding on macOS, just straight filesystem paths
  return path
}

function rbCueToPoint(row: Record<string, unknown>, fallbackIndex: number): CuePoint {
  return {
    index: row.Hot != null ? Number(row.Hot) : fallbackIndex,
    type: row.Hot != null ? 'hotcue' : 'memory',
    positionMs: Number(row.InMsec ?? 0),
    color: rbColorIdToHex(row.Color as number | null),
    label: String(row.Comment ?? '')
  }
}

function rbColorIdToHex(colorId: number | null): string {
  const colors: Record<number, string> = {
    1: '#ff4136', 2: '#ff7043', 3: '#ffd700',
    4: '#2ecc40', 5: '#00bcd4', 6: '#0074d9',
    7: '#b10dc9', 8: '#ff69b4'
  }
  return colors[colorId ?? 0] ?? '#ff8c00'
}

function hexToRbColor(hex: string): number {
  const map: Record<string, number> = {
    '#ff4136': 1, '#ff7043': 2, '#ffd700': 3,
    '#2ecc40': 4, '#00bcd4': 5, '#0074d9': 6,
    '#b10dc9': 7, '#ff69b4': 8
  }
  return map[hex.toLowerCase()] ?? 1
}

function rbKeyToName(key: string | null): string | null {
  if (!key) return null
  // Rekordbox 6/7 stores key as a string like "C", "C#", "Am", etc.
  // or as a numeric ID — return as-is if it's already a string
  return key
}

function rbRatingToStars(rating: number | null): number {
  if (!rating) return 0
  // Rekordbox rating: 0, 51, 102, 153, 204, 255 → 0-5 stars
  const map: Record<number, number> = { 51: 1, 102: 2, 153: 3, 204: 4, 255: 5 }
  return map[rating] ?? 0
}

function starsToRbRating(stars: number): number {
  const map: Record<number, number> = { 0: 0, 1: 51, 2: 102, 3: 153, 4: 204, 5: 255 }
  return map[stars] ?? 0
}
