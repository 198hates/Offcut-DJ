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
import { rbScaleNameToCamelot } from '../key-notation'
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
// Rekordbox 6/7 uses SQLCipher 4 with the key as an ASCII passphrase through
// PBKDF2-HMAC-SHA512 (256000 iterations). The key looks like hex but is NOT
// used as raw bytes — it is treated as a 64-character ASCII string by SQLCipher.

function openRekordboxDb(
  masterDbPath: string,
  readonly: boolean
): InstanceType<typeof SqlCipherDatabase> | null {
  let db: InstanceType<typeof SqlCipherDatabase> | null = null
  try {
    db = new SqlCipherDatabase(masterDbPath, { readonly })
    db.pragma("cipher='sqlcipher'")
    db.pragma('legacy=4')
    db.exec(`PRAGMA key='${RB_KEY}'`)
    // Verify the database is accessible
    db.prepare('SELECT COUNT(*) as c FROM djmdContent').get()
    return db
  } catch (err) {
    try { db?.close() } catch { /* ignore */ }
    console.error(`[rekordbox] Cannot open database: ${(err as Error).message}`)
    return null
  }
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
    // RB7 normalised artist/album/genre/key into lookup tables — use LEFT JOINs
    const tracks = rb
      .prepare(`
        SELECT c.ID, c.FolderPath, c.Title,
               ar.Name  AS ArtistName,
               al.Name  AS AlbumName,
               g.Name   AS GenreName,
               k.ScaleName AS Tonality,
               lb.Name  AS LabelName,
               c.BPM, c.StockDate, c.Rating, c.Commnt, c.Length,
               c.ReleaseYear
        FROM djmdContent c
        LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID
        LEFT JOIN djmdAlbum  al ON al.ID = c.AlbumID
        LEFT JOIN djmdGenre  g  ON g.ID  = c.GenreID
        LEFT JOIN djmdKey    k  ON k.ID  = c.KeyID
        LEFT JOIN djmdLabel  lb ON lb.ID = c.LabelID
        WHERE c.FolderPath IS NOT NULL AND c.FolderPath != ''
      `)
      .all() as Record<string, unknown>[]

    const insertTrack = appDb.transaction((track: Track) => insertOrUpdateTrack(appDb, track))

    for (const row of tracks) {
      try {
        const rbId = String(row.ID)
        // RB7: Hot column replaced by Kind (0=memory,1=hotcue,4=loop,5=hot-loop)
        // and ColorTableIndex for the hotcue slot number
        const cues = rb
          .prepare(`
            SELECT InMsec, Kind, ColorTableIndex, Color, Comment
            FROM djmdCue
            WHERE ContentID = ?
            ORDER BY Kind, InMsec
          `)
          .all(rbId) as Record<string, unknown>[]

        const track: Track = {
          id: randomUUID(),
          filePath: decodeRbPath(String(row.FolderPath ?? '')),
          title: String(row.Title ?? ''),
          artist: String(row.ArtistName ?? ''),
          album: String(row.AlbumName ?? ''),
          genre: String(row.GenreName ?? ''),
          year: row.ReleaseYear != null ? Number(row.ReleaseYear) : null,
          label: String(row.LabelName ?? ''),
          bpm: row.BPM != null ? Number(row.BPM) / 100 : null,
          key: rbScaleNameToCamelot(row.Tonality as string | null),
          durationSeconds: row.Length != null ? Number(row.Length) : null,
          rating: rbRatingToStars(row.Rating as number | null),
          dateAdded: String(row.StockDate ?? new Date().toISOString()),
          comment: String(row.Commnt ?? ''),
          tags: [],
          customTags: {},
          cuePoints: cues.map((c, i) => rbCueToPoint(c, i)),
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
      // RB7: ArtistName/AlbumName/GenreName/Tonality are now in lookup tables —
      // only update fields that still live directly on djmdContent
      rb.prepare(`
        UPDATE djmdContent SET
          Title = ?,
          BPM = ?,
          Rating = ?,
          Commnt = ?,
          updated_at = datetime('now')
        WHERE ID = ?
      `).run(
        track.title,
        track.bpm != null ? Math.round(track.bpm * 100) : null,
        starsToRbRating(track.rating),
        track.comment,
        rbId
      )

      if (track.cuePoints.length > 0) {
        rb.prepare('DELETE FROM djmdCue WHERE ContentID = ?').run(rbId)
        const insertCue = rb.prepare(`
          INSERT INTO djmdCue (ContentID, InMsec, Kind, ColorTableIndex, Color, Comment, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `)
        for (const cue of track.cuePoints) {
          const kind = cue.type === 'loop' ? 4 : cue.type === 'hotcue' ? 1 : 0
          insertCue.run(
            rbId,
            cue.positionMs,
            kind,
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
  // RB7: Kind 1=hotcue, 4=loop, 5=hot-loop; ColorTableIndex is the hotcue slot
  const kind = Number(row.Kind ?? 0)
  const isHot = kind === 1 || kind === 5
  const isLoop = kind === 4 || kind === 5
  return {
    index: isHot ? Number(row.ColorTableIndex ?? fallbackIndex) : fallbackIndex,
    type: isLoop ? 'loop' : isHot ? 'hotcue' : 'memory',
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
