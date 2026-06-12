/**
 * IPC handlers for ProLink B2B capture.
 *
 * Push events (status updates, captured tracks) are sent to the renderer via
 * webContents.send — the same pattern used by library:watchFolderAdded.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { ProLinkCapture, listNetworkInterfaces } from '../integrations/prolink/capture'
import { getLibraryDb, insertOrUpdateTrack } from '../library/db'
import type { PlayerStatus, CapturedTrack, Track } from '../../shared/types'

let capture: ProLinkCapture | null = null
let sessionState: 'idle' | 'connecting' | 'active' | 'error' | 'stopping' = 'idle'
let playerStatuses: PlayerStatus[] = []
let capturedTracks: CapturedTrack[] = []

function pushToRenderer(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

function pushSessionState(): void {
  pushToRenderer('prolink:sessionState', { state: sessionState, playerStatuses, capturedTracks })
}

/**
 * Normalise a string for fuzzy matching: lowercase, collapse whitespace,
 * strip common punctuation. Keeps the approach stable across ProLink metadata
 * and library entries that may have been imported from different sources.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[''`']/g, "'")   // smart quotes → plain apostrophe
    .replace(/[^\w\s']/g, ' ') // strip punctuation except apostrophe
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Look up a track in the local library by title + artist.
 * Returns `{ id }` on the first case-insensitive match, or `null`.
 */
let _normRegistered = false

function lookupInLibrary(title: string, artist: string): { id: string } | null {
  try {
    const db = getLibraryDb()
    const nt = normalise(title)
    const na = normalise(artist)

    // Compare like-with-like: the DB side must apply the SAME normalisation —
    // lower() alone left punctuation/whitespace in the row value, so
    // normalised ProLink metadata almost never matched the library.
    if (!_normRegistered) {
      db.function('offcut_norm', { deterministic: true }, (s: unknown) => normalise(String(s ?? '')))
      _normRegistered = true
    }

    // Try exact normalised match first
    const rows = db.prepare(
      'SELECT id, title, artist FROM tracks WHERE offcut_norm(title) = ? AND offcut_norm(artist) = ? LIMIT 5'
    ).all(nt, na) as { id: string; title: string; artist: string }[]

    if (rows.length > 0) return { id: rows[0].id }

    // Fallback: just title match (useful when artist varies e.g. remix credits)
    const titleRows = db.prepare(
      'SELECT id, title, artist FROM tracks WHERE offcut_norm(title) = ? LIMIT 3'
    ).all(nt) as { id: string; title: string; artist: string }[]

    // Only accept title-only match if the normalised artist is a substring
    const titleMatch = titleRows.find((r) => {
      const la = normalise(r.artist)
      return la.includes(na) || na.includes(la)
    })
    return titleMatch ? { id: titleMatch.id } : null
  } catch {
    return null
  }
}

export function registerProLinkHandlers(): void {
  // ── getNetworkInterfaces ──────────────────────────────────────────────────
  ipcMain.handle('prolink:getNetworkInterfaces', () => {
    return listNetworkInterfaces()
  })

  // ── getSessionState ───────────────────────────────────────────────────────
  ipcMain.handle('prolink:getSessionState', () => {
    return { state: sessionState, playerStatuses, capturedTracks }
  })

  // ── start ─────────────────────────────────────────────────────────────────
  ipcMain.handle('prolink:start', async (_e, ifaceAddress?: string) => {
    if (capture) return { ok: false, error: 'Capture already running' }

    sessionState = 'connecting'
    playerStatuses = []
    capturedTracks = []
    pushSessionState()

    capture = new ProLinkCapture()

    // Wire library lookup so captured tracks know if they're already owned
    capture.setLibraryLookup(lookupInLibrary)

    capture.setOnStatus((statuses) => {
      playerStatuses = statuses
      pushToRenderer('prolink:statusUpdate', statuses)
    })

    capture.setOnCaptured((track) => {
      capturedTracks.push(track)
      pushToRenderer('prolink:trackCaptured', track)
    })

    capture.setOnError((message) => {
      sessionState = 'error'
      pushToRenderer('prolink:error', message)
      pushSessionState()
      // Tear the session down before dropping the reference — nulling it
      // alone leaked the live network session (sockets stayed bound).
      capture?.stop().catch(() => {})
      capture = null
    })

    try {
      const ifaces = listNetworkInterfaces()
      const target = ifaceAddress
        ? ifaces.find((i) => i.address === ifaceAddress)
        : null

      if (target) {
        await capture.startWithIface(target)
      } else {
        await capture.start()
      }

      // If onError fired synchronously during start it will have cleared capture
      if (capture) {
        sessionState = 'active'
        pushSessionState()
        return { ok: true }
      }
      // onError already ran: report the failure instead of ok:true.
      return { ok: false, error: 'ProLink services unavailable' }
    } catch (err) {
      sessionState = 'error'
      pushSessionState()
      capture = null
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── stop ──────────────────────────────────────────────────────────────────
  ipcMain.handle('prolink:stop', async () => {
    if (!capture) return { ok: true, capturedTracks }

    sessionState = 'stopping'
    pushSessionState()

    try {
      await capture.stop()
    } catch { /* ignore */ }

    capture = null
    sessionState = 'idle'
    playerStatuses = []
    pushSessionState()

    return { ok: true, capturedTracks }
  })

  // ── importUnownedTrack ────────────────────────────────────────────────────
  // Creates a stub library entry from a captured ProLink track so the user can
  // acquire the real file later (via path mapping / auto-locate).
  // Uses a synthetic file path `prolink://<player>/<trackTitle>` so the entry
  // is unique and queryable, but clearly marked as needing acquisition.
  ipcMain.handle('prolink:importUnownedTrack', (_e, capturedId: string) => {
    const ct = capturedTracks.find((t) => t.id === capturedId)
    if (!ct) return { ok: false, error: 'Captured track not found' }
    if (ct.inLibrary && ct.localTrackId) return { ok: true, localTrackId: ct.localTrackId }

    try {
      const db = getLibraryDb()

      // Synthetic path — unique, clearly not a real file path
      const syntheticPath = `prolink://player${ct.player}/${encodeURIComponent(ct.title)}__${encodeURIComponent(ct.artist)}`

      // Check if we already have a stub for this track (re-import guard)
      const existing = db.prepare(
        'SELECT id FROM tracks WHERE file_path = ? LIMIT 1'
      ).get(syntheticPath) as { id: string } | undefined

      const trackId = existing?.id ?? randomUUID()

      if (!existing) {
        const track: Track = {
          id:              trackId,
          filePath:        syntheticPath,
          title:           ct.title,
          artist:          ct.artist,
          album:           ct.album,
          genre:           ct.genre,
          year:            ct.year,
          label:           ct.label,
          bpm:             ct.bpm,
          key:             ct.key,
          durationSeconds: ct.durationSeconds,
          rating:          0,
          dateAdded:       new Date().toISOString(),
          comment:         `Captured via ProLink from player ${ct.player} — file not yet in library`,
          tags:            ['prolink-discovery'],
          customTags:      {},
          cuePoints:       [],
          beatgrid:        [],
          energy:          null,
          danceability:    null,
          mood:            null,
          analysedBeatgrid: null,
          editLineage:     null,
          color:           '',
          playCount:       0,
          lastPlayedAt:    null,
          updatedAt:       null,
          fileSize:        null,
          fileType:        null,
          sampleRate:      null,
          bitDepth:        null,
          gainDb:          null,
          phrases:         null,
          sourceIds:       { prolink: `player${ct.player}` },
        }
        insertOrUpdateTrack(db, track)
      }

      // Update the in-memory captured track list so the UI reflects the change
      const idx = capturedTracks.findIndex((t) => t.id === capturedId)
      if (idx !== -1) {
        capturedTracks[idx] = { ...capturedTracks[idx], inLibrary: true, localTrackId: trackId }
        // Push the updated list so the renderer can refresh
        pushToRenderer('prolink:trackUpdated', capturedTracks[idx])
      }

      return { ok: true, localTrackId: trackId }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
