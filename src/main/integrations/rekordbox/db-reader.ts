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
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import SqlCipherDatabase from 'better-sqlite3-multiple-ciphers'
import { rowToTrack, insertOrUpdateTrack } from '../../library/db'
import { rbScaleNameToCamelot } from '../key-notation'
import type { Track, TrackInput, CuePoint, ImportResult, ExportResult } from '../../../shared/types'
import { findPlaylistIdBySource } from '../../library/migrations/dedupe-playlists'
import { resolvePlaylistTree, type RbPlaylistRow } from './playlist-tree'
import {
  planOrphanPrune, type RekordboxRow, type PlaylistMembership, type Replacements
} from './prune-orphans'
import {
  planPlaylistWriteback, planSongPlaylistInsert,
  type PlaylistEntry, type ColumnInfo
} from './playlist-writeback'
import { guardRekordboxWrite } from './write-guard'
import { rbTimestamp, newCueId } from './cue-format'

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
        /* rb_local_deleted is rekordbox's soft delete, and it is also what the
           orphan prune below sets. Without this filter an import re-created every
           row the last export had just retired — the removed duplicate came back
           as a fresh track pointing at a file in the Trash, so dedupe was undone
           by the next sync. */
        WHERE c.FolderPath IS NOT NULL AND c.FolderPath != ''
          AND COALESCE(c.rb_local_deleted, 0) = 0
      `)
      .all() as Record<string, unknown>[]

    const insertTrack = appDb.transaction((track: TrackInput) => insertOrUpdateTrack(appDb, track))

    for (const row of tracks) {
      try {
        const rbId = String(row.ID)
        // RB7: Hot column replaced by Kind (0=memory,1=hotcue,4=loop,5=hot-loop)
        // and ColorTableIndex for the hotcue slot number
        const cues = rb
          .prepare(`
            SELECT InMsec, Kind, ColorTableIndex, Color, Comment
            FROM djmdCue
            WHERE ContentID = ? AND COALESCE(rb_local_deleted, 0) = 0
            ORDER BY Kind, InMsec
          `)
          .all(rbId) as Record<string, unknown>[]

        const track: TrackInput = {
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
        WHERE p.Name IS NOT NULL AND COALESCE(p.rb_local_deleted, 0) = 0
        ORDER BY p.Seq
      `)
      .all() as Record<string, unknown>[]

    // Resolve ids and parents up front. `ORDER BY Seq` is rekordbox's DISPLAY
    // order, not a topological one, so a child is routinely read before its
    // parent — resolving inline against a half-built map silently dropped those
    // links and flattened the folder tree (143 of 286 survived on a real
    // library). See playlist-tree.ts.
    const resolved = resolvePlaylistTree(
      playlists as unknown as RbPlaylistRow[],
      (rbId) => findPlaylistIdBySource(appDb, 'rekordbox', rbId),
      () => randomUUID()
    )

    for (let i = 0; i < resolved.length; i++) {
      const pl = playlists[i]
      const rbPlId = resolved[i].rbId
      const internalId = resolved[i].internalId
      const isFolder = resolved[i].isFolder

      // parent_id is written in a second pass below, NOT here: now that the tree
      // is resolved up front, a child can be inserted before its parent exists,
      // and parent_id is a foreign key — inserting it inline would fail.
      appDb.prepare(`
        INSERT OR REPLACE INTO playlists (id, name, is_folder, parent_id, sort_order, source_ids)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(internalId, String(pl.Name), isFolder ? 1 : 0, i, JSON.stringify({ rekordbox: rbPlId }))

      if (!isFolder) {
        const songs = rb
          .prepare(
            `SELECT ContentID, TrackNo FROM djmdSongPlaylist
             WHERE PlaylistID = ? AND COALESCE(rb_local_deleted, 0) = 0
             ORDER BY TrackNo`
          )
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

    // Second pass: every playlist row now exists, so the foreign key resolves.
    const setParent = appDb.prepare('UPDATE playlists SET parent_id = ? WHERE id = ?')
    for (const r of resolved) {
      if (r.parentInternalId) setParent.run(r.parentInternalId, r.internalId)
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
  masterDbPath: string,
  /* Off by default, and deliberately ONE switch for both halves of the playlist
     story. Reporting what is out of step is always safe; changing it is the
     caller's call, because it is the only part of this export that takes
     something away rather than filling something in.

     The two must not be separable. The prune retires a dead row's playlist
     entries, and that is only safe once the surviving copy has been inserted in
     its place — so enabling the prune without the writeback is exactly the
     configuration that makes playlists lose tracks. */
  syncPlaylists = false
): ExportResult {
  const result: ExportResult = {
    tracksExported: 0, playlistsExported: 0, errors: [], cancelled: false,
    orphansFound: 0, orphansPruned: 0,
    playlistEntriesFound: 0, playlistEntriesAdded: 0, playlistEntriesUnplaceable: 0,
    titlesKept: 0, ratingsKept: 0, commentsKept: 0
  }
  /** Tracks left alone because rekordbox already had cues for them. */
  let cuesSkipped = 0
  /** Tracks whose rekordbox title/rating/comment differed from Offcut's and was kept. */
  let titlesKept = 0
  let ratingsKept = 0
  let commentsKept = 0

  // This is the ONLY path that writes to someone's rekordbox library. Refuse if
  // rekordbox is open, and take a copy first — the write is not reversible.
  const guard = guardRekordboxWrite(masterDbPath)
  if (!guard.ok) {
    result.errors.push(guard.error ?? 'Rekordbox write blocked')
    return result
  }
  console.info(`[rekordbox] backed up master.db before export → ${guard.backupPath}`)

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

    /* Read only to REPORT what the guards above left alone — the UPDATE decides
       for itself in SQL. Skipped entirely unless Offcut has something to push,
       so a library with no ratings or comments pays nothing for this. */
    const readUserFields = rb.prepare('SELECT Title, Rating, Commnt FROM djmdContent WHERE ID = ?')

    const updateTrack = rb.transaction((track: Track, rbId: string) => {
      if (track.title !== '' || track.rating > 0 || track.comment !== '') {
        const cur = readUserFields.get(rbId) as
          | { Title: string | null; Rating: number | null; Commnt: string | null }
          | undefined
        if (cur) {
          // Only a DIFFERING value is worth reporting; an identical one was
          // never going to change anything either way.
          if (
            track.title !== '' && cur.Title != null && cur.Title !== '' &&
            cur.Title !== track.title
          ) titlesKept++
          if (
            track.rating > 0 && cur.Rating != null && cur.Rating !== 0 &&
            cur.Rating !== starsToRbRating(track.rating)
          ) ratingsKept++
          if (
            track.comment !== '' && cur.Commnt != null && cur.Commnt !== '' &&
            cur.Commnt !== track.comment
          ) commentsKept++
        }
      }
      // RB7: ArtistName/AlbumName/GenreName/Tonality are now in lookup tables —
      // only update fields that still live directly on djmdContent
      rb.prepare(`
        UPDATE djmdContent SET
          /* Title is guarded on the same principle as Rating and Commnt below,
             with one consequence worth being explicit about: rekordbox has a
             title for very nearly every track, so in practice this write now
             almost never fires. That is the intended outcome — Offcut does not
             rename tracks in someone else's library — but it does mean a retitle
             done in Offcut will not reach rekordbox. FolderPath/FileNameL are
             what the relink needs, and they stay unconditional below. */
          Title = CASE WHEN Title IS NULL OR Title = '' THEN ? ELSE Title END,
          /* BPM only when rekordbox has none. Offcut's analyser and rekordbox's
             disagree on some tracks — one measured case read 136.00 as 90.90
             (a two-thirds-time error) — and writing unconditionally let a bad
             analysis silently replace a correct value the user had relied on.
             Filling a blank is useful; overwriting an existing reading is not
             ours to do. */
          BPM = CASE WHEN BPM IS NULL OR BPM = 0 THEN ? ELSE BPM END,
          /* Rating and Commnt follow the same rule, and for the same reason.
             These are things the user typed, on either side, and the export had
             no idea which side typed them last: it pushed Offcut's copy every
             time, so a star rating or a comment edited IN REKORDBOX since the
             previous import was silently reverted on the next sync. Worse, a
             track Offcut had never carried a rating or comment for pushed 0 and
             '' over whatever rekordbox held, destroying it outright for no gain.

             Rating 0 is rekordbox's "unrated", so it doubles as the blank here
             (starsToRbRating maps stars onto 0/20/.../100). */
          Rating = CASE WHEN Rating IS NULL OR Rating = 0 THEN ? ELSE Rating END,
          Commnt = CASE WHEN Commnt IS NULL OR Commnt = '' THEN ? ELSE Commnt END,
          FolderPath = ?,
          /* FolderPath is the full path INCLUDING the filename, and FileNameL
             is that same basename held separately. The organiser renames on
             collision ("track (1).mp3"), so writing only FolderPath left the
             two disagreeing about what the file is called. */
          FileNameL = ?,
          updated_at = datetime('now')
        WHERE ID = ?
      `).run(
        track.title,
        track.bpm != null ? Math.round(track.bpm * 100) : null,
        starsToRbRating(track.rating),
        track.comment,
        encodeRbPath(track.filePath),
        basename(track.filePath),
        rbId
      )

      /* Cues are only written to a track rekordbox has NONE for.
         This block used to delete-then-reinsert unconditionally, replacing
         hand-placed cues with Offcut's auto-generated ones — on a real library
         that turned 1,044 user cues into 37,746 generated ones with zero
         originals surviving. There is deliberately no DELETE in this path any
         more: the export cannot remove a rekordbox cue under any circumstances. */
      if (track.cuePoints.length > 0) {
        const existingCues = (
          rb.prepare('SELECT COUNT(*) AS c FROM djmdCue WHERE ContentID = ?').get(rbId) as { c: number }
        ).c
        if (existingCues > 0) {
          cuesSkipped++
        } else {
          /* Every column rekordbox itself populates, not the minimum that
             parses. Omitting created_at — NOT NULL, no default — made EVERY
             track carrying cues fail with "NOT NULL constraint failed:
             djmdCue.created_at". ID is a VARCHAR primary key SQLite will not
             generate and, being non-INTEGER, will happily leave NULL;
             UUID/ContentUUID are what rekordbox's own sync keys on. */
          const contentUuid = (
            rb.prepare('SELECT UUID FROM djmdContent WHERE ID = ?').get(rbId) as { UUID?: string } | undefined
          )?.UUID ?? null
          const insertCue = rb.prepare(`
            INSERT INTO djmdCue (
              ID, ContentID, ContentUUID, InMsec, Kind, ColorTableIndex, Color,
              Comment, UUID, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          for (const cue of track.cuePoints) {
            const kind = cue.type === 'loop' ? 4 : cue.type === 'hotcue' ? 1 : 0
            insertCue.run(
              newCueId(),
              rbId,
              contentUuid,
              /* Rounded: InMsec is INTEGER and rekordbox stores whole
                 milliseconds, but Offcut carries sub-millisecond positions, and
                 SQLite only coerces a float when lossless — so 6900.162034151814
                 was stored AS a float in an integer column (36,640 of 37,746
                 rows in a measured export). */
              Math.round(cue.positionMs),
              kind,
              cue.type === 'hotcue' ? cue.index : null,
              hexToRbColor(cue.color),
              cue.label,
              randomUUID(),
              rbTimestamp(),
              rbTimestamp()
            )
          }
        }
      }
    })

    const liveRbIds = new Set<string>()
    for (const row of tracks) {
      try {
        const track = rowToTrack(row)
        const rbId = String((track.sourceIds as Record<string, string>).rekordbox)
        updateTrack(track, rbId)
        liveRbIds.add(rbId)
        result.tracksExported++
      } catch (err) {
        result.errors.push(`Track sync error: ${(err as Error).message}`)
      }
    }

    /* ── Playlist membership ──────────────────────────────────────────────
       Offcut's view of which tracks are in which playlist, for playlists that
       came from rekordbox. After a duplicate is resolved this is where the
       kept copy sits in place of the removed one, and it is the whole reason
       the writeback exists. Folders hold no tracks and smart playlists compute
       theirs, so neither has membership to push. */
    const wanted = (
      appDb
        .prepare(`
          SELECT json_extract(p.source_ids, '$.rekordbox') AS playlistId,
                 json_extract(t.source_ids, '$.rekordbox') AS contentId,
                 pt.sort_order                             AS trackNo
          FROM playlist_tracks pt
          JOIN playlists p ON p.id = pt.playlist_id
          JOIN tracks    t ON t.id = pt.track_id
          WHERE json_extract(p.source_ids, '$.rekordbox') IS NOT NULL
            AND json_extract(t.source_ids, '$.rekordbox') IS NOT NULL
            AND p.is_folder = 0 AND p.is_smart = 0
          ORDER BY pt.sort_order
        `)
        .all() as { playlistId: string; contentId: string; trackNo: number | null }[]
    ).map((r) => ({
      playlistId: String(r.playlistId),
      contentId: String(r.contentId),
      trackNo: r.trackNo ?? 0
    }))

    // rekordbox's live membership, and the ids that exist at all. Foreign keys
    // are ON, so inserting against a playlist or track rekordbox has since
    // deleted would abort the transaction rather than skip a row.
    const asPair = (e: { PlaylistID: string; ContentID: string }): PlaylistEntry => ({
      playlistId: String(e.PlaylistID),
      contentId: String(e.ContentID),
      trackNo: 0
    })
    /* TWO views of rekordbox's membership, and the difference matters.

       `existingAny` includes soft-deleted rows, and is what decides whether to
       insert: a retired row still occupies the (PlaylistID, ContentID) unique
       key, so inserting over it fails and — inside one transaction — rolls back
       every other entry with it. That is not hypothetical: remove a track from a
       playlist in rekordbox while Offcut still has it there, and this is exactly
       the collision you get. Skipping those pairs is right in its own terms too;
       rekordbox retired that entry deliberately and re-adding it would be Offcut
       overruling the user.

       `existingLive` is only the rows that count as present, and feeds the prune's
       playlist-coverage rule below. */
    const existingAny = (
      rb.prepare('SELECT PlaylistID, ContentID FROM djmdSongPlaylist').all() as {
        PlaylistID: string
        ContentID: string
      }[]
    ).map(asPair)
    const existingLive = (
      rb
        .prepare(
          `SELECT PlaylistID, ContentID FROM djmdSongPlaylist
           WHERE COALESCE(rb_local_deleted, 0) = 0`
        )
        .all() as { PlaylistID: string; ContentID: string }[]
    ).map(asPair)
    const livePlaylistIds = new Set(
      (rb.prepare(
        `SELECT ID FROM djmdPlaylist WHERE COALESCE(rb_local_deleted, 0) = 0`
      ).all() as { ID: string }[]).map((r) => String(r.ID))
    )
    const liveContentIds = new Set(
      (rb.prepare(
        `SELECT ID FROM djmdContent WHERE COALESCE(rb_local_deleted, 0) = 0`
      ).all() as { ID: string }[]).map((r) => String(r.ID))
    )

    /* Entries whose PLAYLIST came from rekordbox but whose TRACK has no rekordbox
       row at all. `wanted` filters these out before they are ever considered, so
       without counting them here they were invisible — a keeper imported from a
       folder simply went missing from the rekordbox playlist and nothing said so.
       This is the number to watch: each one is a track rekordbox has never heard
       of, and importing those files into rekordbox once makes them sync normally. */
    const noRekordboxRow = (
      appDb
        .prepare(`
          SELECT COUNT(*) AS c
          FROM playlist_tracks pt
          JOIN playlists p ON p.id = pt.playlist_id
          JOIN tracks    t ON t.id = pt.track_id
          WHERE json_extract(p.source_ids, '$.rekordbox') IS NOT NULL
            AND json_extract(t.source_ids, '$.rekordbox') IS NULL
            AND p.is_folder = 0 AND p.is_smart = 0
        `)
        .get() as { c: number }
    ).c

    const pending = planPlaylistWriteback(wanted, existingAny)
    /* Entries we cannot place: the kept copy has no rekordbox row of its own
       (it was imported from a folder, not from rekordbox), or the playlist is
       gone. Counted and surfaced rather than dropped — an unplaceable entry is
       precisely the case where pruning the copy it replaces would make the
       track vanish from that playlist, and rule 4 below relies on knowing. */
    const placeable = pending.filter(
      (e) => livePlaylistIds.has(e.playlistId) && liveContentIds.has(e.contentId)
    )
    result.playlistEntriesFound = pending.length
    // Both flavours of "cannot be written": a stale rekordbox id, and no id at all.
    result.playlistEntriesUnplaceable = pending.length - placeable.length + noRekordboxRow
    result.playlistEntriesNoRekordboxRow = noRekordboxRow

    if (syncPlaylists && placeable.length > 0) {
      const cols = rb
        .prepare(`SELECT name, notnull, dflt_value FROM pragma_table_info('djmdSongPlaylist')`)
        .all() as ColumnInfo[]
      // Values we are willing to supply. Everything else — rekordbox's own sync
      // bookkeeping (usn, rb_data_status and friends) — is left to its defaults.
      const values: Record<string, (e: PlaylistEntry) => unknown> = {
        ID: () => newCueId(),
        PlaylistID: (e) => e.playlistId,
        ContentID: (e) => e.contentId,
        TrackNo: (e) => Math.max(0, Math.round(e.trackNo)),
        UUID: () => randomUUID(),
        created_at: () => rbTimestamp(),
        updated_at: () => rbTimestamp()
      }
      const plan = planSongPlaylistInsert(cols, Object.keys(values))

      if (plan.blockedBy.length > 0) {
        result.errors.push(
          `Playlist sync skipped: djmdSongPlaylist requires column(s) ` +
          `${plan.blockedBy.join(', ')} that Offcut has no value for. ` +
          `Tracks and cues were still synced.`
        )
      } else {
        /* OR IGNORE as a backstop, not as the plan: `existingAny` should already
           have excluded every colliding pair, but this is someone's library and
           a constraint we did not predict must cost one skipped row rather than
           the whole batch. Counted from `changes` so the report stays truthful
           about what actually landed. */
        const insert = rb.prepare(
          `INSERT OR IGNORE INTO djmdSongPlaylist (${plan.columns.join(', ')})
           VALUES (${plan.columns.map(() => '?').join(', ')})`
        )
        const added: PlaylistEntry[] = []
        const addEntries = rb.transaction((entries: PlaylistEntry[]) => {
          for (const e of entries) {
            const info = insert.run(...plan.columns.map((c) => values[c](e)))
            if (info.changes > 0) added.push(e)
          }
        })
        try {
          addEntries(placeable)
          result.playlistEntriesAdded = added.length
          result.playlistsExported = new Set(added.map((e) => e.playlistId)).size
          // Only rows that really landed may vouch for a prune below.
          for (const e of added) existingLive.push(e)
        } catch (err) {
          result.errors.push(`Playlist sync failed: ${(err as Error).message}`)
        }
      }
    }

    /* Rows the duplicate tool retired. planOrphanPrune acts only on pairings
       mergeDuplicateInto recorded — this row was replaced by that track — never
       on a guess about a missing file, so an unmounted drive cannot look like a
       pile of deletions. */
    const candidates = rb
      .prepare(
        `SELECT ID, FolderPath, Title, FileSize FROM djmdContent
         WHERE COALESCE(rb_local_deleted, 0) = 0`
      )
      .all() as RekordboxRow[]
    /* Membership AFTER the inserts above (they were appended to `existing`), so
       rule 4 sees the replacement that was just placed. Live rows only: a
       soft-deleted entry is not a replacement, and with the writeback off
       nothing was added, so a row whose replacement is not already there
       simply is not prunable. */
    const membership: PlaylistMembership = new Map()
    for (const e of existingLive) {
      const set = membership.get(e.contentId)
      if (set) set.add(e.playlistId)
      else membership.set(e.contentId, new Set([e.playlistId]))
    }
    /* The recorded pairings, resolved through each keeper's CURRENT rekordbox id
       so a keeper that only gained a rekordbox row after the dedupe still works. */
    const replacements: Replacements = new Map()
    for (const r of appDb
      .prepare(`
        SELECT r.removed_rb_id AS removedId,
               json_extract(t.source_ids, '$.rekordbox') AS keeperId
        FROM duplicate_replacements r
        JOIN tracks t ON t.id = r.keeper_track_id
      `)
      .all() as { removedId: string; keeperId: string | null }[]) {
      // Keep the null: a keeper with no rekordbox row is the case worth reporting.
      replacements.set(String(r.removedId), r.keeperId == null ? null : String(r.keeperId))
    }

    const decision = planOrphanPrune(candidates, liveRbIds, replacements, membership)
    const orphans = decision.prunable
    result.orphansFound = orphans.length
    result.orphansBlocked = decision.blocked.length
    if (decision.blocked.length > 0) {
      const notCovered = decision.blocked.filter((b) => b.reason === 'playlist-not-covered').length
      const noKeeper = decision.blocked.length - notCovered
      console.info(
        `[rekordbox] left ${decision.blocked.length} retired duplicate(s) in place — ` +
        `${noKeeper} whose kept copy has no rekordbox row, ${notCovered} whose kept copy ` +
        `is not yet in every playlist the old one was in`
      )
    }

    if (orphans.length > 0 && syncPlaylists) {
      // rb_local_deleted is rekordbox's own soft delete — recoverable, and the
      // row keeps its analysis. Playlist entries go too, or the playlists show
      // entries that resolve to nothing.
      const markContent = rb.prepare(
        `UPDATE djmdContent SET rb_local_deleted = 1, updated_at = datetime('now') WHERE ID = ?`
      )
      const markEntries = rb.prepare(
        `UPDATE djmdSongPlaylist SET rb_local_deleted = 1, updated_at = datetime('now') WHERE ContentID = ?`
      )
      const prune = rb.transaction((ids: string[]) => {
        for (const id of ids) { markContent.run(id); markEntries.run(id) }
      })
      try {
        prune(orphans)
        result.orphansPruned = orphans.length
      } catch (err) {
        result.errors.push(`Orphan cleanup failed: ${(err as Error).message}`)
      }
    }
  } finally {
    rb.close()
  }

  // Say what was left alone, so "my cues didn't sync" is never a silent mystery.
  if (cuesSkipped > 0) {
    console.info(
      `[rekordbox] kept existing cues on ${cuesSkipped} track(s) — Offcut only fills tracks that have none`
    )
  }
  result.titlesKept = titlesKept
  result.ratingsKept = ratingsKept
  result.commentsKept = commentsKept
  if (titlesKept > 0 || ratingsKept > 0 || commentsKept > 0) {
    console.info(
      `[rekordbox] kept rekordbox's own value on ${titlesKept} title(s), ` +
      `${ratingsKept} rating(s) and ${commentsKept} comment(s) — Offcut only fills ` +
      `a blank, it does not replace something you typed in rekordbox`
    )
  }

  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeRbPath(path: string): string {
  // Rekordbox stores paths without URL encoding on macOS, just straight filesystem paths
  return path
}

function encodeRbPath(path: string): string {
  // Symmetric with decodeRbPath — Rekordbox expects the same plain filesystem path back.
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
