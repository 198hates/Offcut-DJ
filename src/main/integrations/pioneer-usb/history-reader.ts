/**
 * pioneer-usb/history-reader.ts
 *
 * Reads HISTORY playlists from a Pioneer CDJ/Rekordbox USB drive.
 *
 * Pioneer CDJ sticks and Rekordbox USB exports store a regular (unencrypted)
 * SQLite database at:
 *   {usbRoot}/PIONEER/rekordbox.db
 *
 * The schema is identical to the desktop Rekordbox database except it is not
 * SQLCipher-encrypted. HISTORY playlists live in djmdPlaylist under a folder
 * whose Name = 'HISTORY', or directly as playlists named 'HISTORY NNN'.
 *
 * This module extracts those sets, cross-references each played track against
 * the local library, and returns structured PlayedSet objects ready for
 * Road-Not-Taken analysis.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { rbScaleNameToCamelot } from '../key-notation'

// ── Public types ─────────────────────────────────────────────────────────────

export interface UsbPlayedTrack {
  /** Title as stored on the USB */
  title:          string
  /** Artist as stored on the USB */
  artist:         string
  /** BPM (raw /100 as stored in rekordbox — already divided here) */
  bpm:            number | null
  /** Camelot key string e.g. "5A" */
  key:            string | null
  /** Duration in seconds */
  durationSeconds: number | null
  /** 0-based position in the set */
  position:       number
  /** Matched local track ID, or null if cross-ref failed */
  localTrackId:   string | null
}

export interface UsbPlayedSet {
  /** Playlist name as stored on USB e.g. "HISTORY 001" */
  name:    string
  /** Rekordbox playlist ID on the USB */
  usbId:   string
  /** Guessed date — taken from the playlist timestamp or null */
  date:    string | null
  tracks:  UsbPlayedTrack[]
}

// ── Internal DB row types ────────────────────────────────────────────────────

interface PlaylistRow {
  ID: string
  Name: string
  ParentID: string | null
  Attribute: number
  Seq: number
}

interface SongRow {
  ContentID: string
  TrackNo:   number
  Title:     string
  ArtistName: string | null
  Tonality:  string | null
  BPM:       number | null
  Length:    number | null
}

// Key conversion (Rekordbox ScaleName → Camelot) is shared with the desktop
// db-reader — see ../key-notation.ts.

// ── Locate the database ───────────────────────────────────────────────────────

/**
 * Auto-discover Pioneer USB mounts on macOS (/Volumes/*) that contain a
 * PIONEER/rekordbox.db. Returns the first match, or null.
 */
export function findPioneerUsbMount(): string | null {
  try {
    const volumes = readdirSync('/Volumes')
    for (const vol of volumes) {
      const dbPath = `/Volumes/${vol}/PIONEER/rekordbox.db`
      if (existsSync(dbPath)) return `/Volumes/${vol}`
    }
  } catch {/* not macOS or no /Volumes */}
  return null
}

export function usbDbPath(usbRoot: string): string {
  return join(usbRoot, 'PIONEER', 'rekordbox.db')
}

// ── Main reader ───────────────────────────────────────────────────────────────

/**
 * Read all HISTORY playlists from the Pioneer USB at `usbRoot`.
 *
 * @param usbRoot   Root of the Pioneer USB (the drive mount point)
 * @param appDb     The local Offcut SQLite database (for cross-referencing tracks)
 * @returns         Array of played sets, newest first
 */
export function readUsbHistory(
  usbRoot: string,
  appDb: Database.Database
): UsbPlayedSet[] {
  const dbPath = usbDbPath(usbRoot)
  if (!existsSync(dbPath)) {
    throw new Error(`Pioneer USB database not found at: ${dbPath}`)
  }

  let usb: Database.Database
  try {
    usb = new Database(dbPath, { readonly: true })
  } catch (err) {
    throw new Error(`Cannot open Pioneer USB database: ${(err as Error).message}`)
  }

  try {
    // ── Find the HISTORY root folder (Attribute=1) or direct HISTORY playlists
    const allPlaylists = usb
      .prepare('SELECT ID, Name, ParentID, Attribute, Seq FROM djmdPlaylist ORDER BY Seq')
      .all() as PlaylistRow[]

    const historyFolderId = allPlaylists.find(
      (p) => p.Attribute === 1 && p.Name.toUpperCase() === 'HISTORY'
    )?.ID ?? null

    // Collect playlists that are either:
    //   (a) children of the HISTORY folder
    //   (b) directly named "HISTORY NNN"
    const historyPlaylists = allPlaylists.filter((p) => {
      if (p.Attribute === 1) return false  // skip folders themselves
      const isChild = historyFolderId && p.ParentID === historyFolderId
      const isNamedHistory = /^HISTORY\s+\d+/i.test(p.Name)
      return isChild || isNamedHistory
    })

    // Reverse so newest (highest seq) is first
    historyPlaylists.reverse()

    const results: UsbPlayedSet[] = []

    for (const pl of historyPlaylists) {
      // Get songs in play order
      let songs: SongRow[]
      try {
        songs = usb
          .prepare(`
            SELECT sp.ContentID, sp.TrackNo,
                   c.Title,
                   ar.Name AS ArtistName,
                   k.ScaleName AS Tonality,
                   c.BPM, c.Length
            FROM djmdSongPlaylist sp
            JOIN djmdContent c ON c.ID = sp.ContentID
            LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID
            LEFT JOIN djmdKey k ON k.ID = c.KeyID
            WHERE sp.PlaylistID = ?
            ORDER BY sp.TrackNo ASC
          `)
          .all(pl.ID) as SongRow[]
      } catch {
        // Old USB schemas may use djmdPlaylistSong — try that
        try {
          songs = usb
            .prepare(`
              SELECT ps.ContentID, ps.TrackNo,
                     c.Title,
                     ar.Name AS ArtistName,
                     k.ScaleName AS Tonality,
                     c.BPM, c.Length
              FROM djmdPlaylistSong ps
              JOIN djmdContent c ON c.ID = ps.ContentID
              LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID
              LEFT JOIN djmdKey k ON k.ID = c.KeyID
              WHERE ps.PlaylistID = ?
              ORDER BY ps.TrackNo ASC
            `)
            .all(pl.ID) as SongRow[]
        } catch {
          songs = []
        }
      }

      // Cross-reference each song against the local library
      const tracks: UsbPlayedTrack[] = songs.map((s, i) => {
        const localTrackId = resolveLocalTrack(appDb, s.ContentID, s.Title, s.ArtistName)
        return {
          title:           s.Title ?? '?',
          artist:          s.ArtistName ?? '',
          bpm:             s.BPM != null ? Number(s.BPM) / 100 : null,
          key:             rbScaleNameToCamelot(s.Tonality),
          durationSeconds: s.Length != null ? Number(s.Length) : null,
          position:        i,
          localTrackId,
        }
      })

      // Guess date from playlist name e.g. "HISTORY 2026-05-17"
      const dateMatch = pl.Name.match(/(\d{4}[-./]\d{2}[-./]\d{2})/)
      const date = dateMatch ? dateMatch[1].replace(/[./]/g, '-') : null

      results.push({ name: pl.Name, usbId: pl.ID, date, tracks })
    }

    return results
  } finally {
    usb.close()
  }
}

// ── Local track cross-reference ───────────────────────────────────────────────

function resolveLocalTrack(
  appDb: Database.Database,
  usbContentId: string,
  title: string,
  artist: string | null
): string | null {
  // 1. Try by rekordbox source ID (if we've imported from the same rekordbox library)
  const byRbId = appDb
    .prepare(`SELECT id FROM tracks WHERE json_extract(source_ids, '$.rekordbox') = ?`)
    .get(usbContentId) as { id: string } | undefined
  if (byRbId) return byRbId.id

  // 2. Fall back to exact title+artist match (case-insensitive)
  if (!title) return null
  const byMeta = appDb
    .prepare(`
      SELECT id FROM tracks
      WHERE LOWER(title) = LOWER(?)
        AND (? IS NULL OR ? = '' OR LOWER(artist) = LOWER(?))
      LIMIT 1
    `)
    .get(title, artist, artist, artist) as { id: string } | undefined

  return byMeta?.id ?? null
}
