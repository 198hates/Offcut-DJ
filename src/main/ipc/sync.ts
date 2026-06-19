// IPC + lifecycle for the phone-sync LAN server.

import { ipcMain, app, BrowserWindow } from 'electron'
import { join } from 'path'
import QRCode from 'qrcode'
import { PairingStore } from '../sync/pairing'
import { SyncServer } from '../sync/server'
import { getLanAddresses } from '../sync/lan-address'
import { getLibraryDb } from '../library/db'
import { pullChanges, leanTrack } from '../library/sync'
import { applyPush } from '../library/apply-push'
import { backfillContentHashesChunked } from '../library/content-hash'
import { getPeaks, getProxyPath, getArtworkPath } from '../sync/media'
import type { SyncStatus } from '../../shared/types'

/** Tell the renderer windows the library changed underneath them (phone push). */
function notifyLibraryChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('sync:libraryChanged')
  }
}

let pairing: PairingStore | null = null
let server: SyncServer | null = null

// Content-hash backfill runs in the background (never on the pull request path —
// hashing files off a cloud drive would freeze the main process). Guarded so
// only one pass runs at a time; it stops itself when the server is shut down.
let backfilling = false
function kickContentHashBackfill(): void {
  if (backfilling) return
  backfilling = true
  void backfillContentHashesChunked(getLibraryDb(), {
    batch: 25,
    shouldStop: () => server === null || !server.running
  })
    .catch((e) => console.warn('[phone-sync] content-hash backfill failed:', (e as Error).message))
    .finally(() => {
      backfilling = false
    })
}

function getPairing(): PairingStore {
  if (!pairing) pairing = new PairingStore(join(app.getPath('userData'), 'phone-sync.json'))
  return pairing
}

function mediaCacheDir(): string {
  return join(app.getPath('userData'), 'media-cache')
}

function getServer(): SyncServer {
  if (!server) {
    const p = getPairing()
    server = new SyncServer({
      verify: (t) => p.verify(t),
      pull: (cursor) => {
        const db = getLibraryDb()
        // Content hashes are only needed for two-way reconciliation (push); the
        // read-only mirror doesn't need them. Backfill them lazily in the
        // background instead of blocking the pull (and the whole event loop).
        kickContentHashBackfill()
        // Send a metadata-only mirror — the per-beat grids would balloon the
        // snapshot to hundreds of MB (see leanTrack).
        const res = pullChanges(db, cursor)
        return { ...res, tracks: res.tracks.map(leanTrack) }
      },
      applyPush: (payload) => {
        const res = applyPush(getLibraryDb(), payload)
        if (res.appliedTracks > 0 || res.appliedPlaylists > 0) notifyLibraryChanged()
        return res
      },
      getPeaks: (trackId) => getPeaks(getLibraryDb(), mediaCacheDir(), trackId),
      getProxyPath: (trackId) => getProxyPath(getLibraryDb(), mediaCacheDir(), trackId),
      getArtwork: (trackId) => getArtworkPath(getLibraryDb(), mediaCacheDir(), trackId),
      recordDevice: (id, name) => p.recordDevice(id, name),
      info: () => ({ name: 'Offcut', version: app.getVersion() })
    })
  }
  return server
}

function status(): SyncStatus {
  const p = getPairing()
  return {
    enabled: p.enabled,
    running: server?.running ?? false,
    port: p.port,
    addresses: getLanAddresses(),
    devices: p.devices.slice()
  }
}

/** Start the server on launch if the user left phone-sync enabled. */
export async function startSyncServerIfEnabled(): Promise<void> {
  const p = getPairing()
  if (!p.enabled) return
  try {
    await getServer().start(p.port)
    kickContentHashBackfill()
  } catch (e) {
    console.warn('[phone-sync] failed to start:', (e as Error).message)
  }
}

export async function stopSyncServer(): Promise<void> {
  if (server) await server.stop()
}

export function registerSyncHandlers(): void {
  ipcMain.handle('sync:status', () => status())

  ipcMain.handle('sync:setEnabled', async (_e, enabled: boolean): Promise<SyncStatus | { error: string }> => {
    const p = getPairing()
    try {
      if (enabled) await getServer().start(p.port)
      else await stopSyncServer()
      p.setEnabled(enabled)
      return status()
    } catch (e) {
      p.setEnabled(false)
      const msg = (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${p.port} is already in use`
        : (e as Error).message
      return { error: msg }
    }
  })

  // Pairing payload + QR. The QR encodes an offcut://pair/<base64url> URI the
  // phone scans to learn the host, port and token in one shot.
  ipcMain.handle('sync:pairing', async () => {
    const p = getPairing()
    const addresses = getLanAddresses()
    const host = addresses[0] ?? '127.0.0.1'
    const payload = Buffer.from(
      JSON.stringify({ v: 1, host, port: p.port, token: p.token, name: 'Offcut' })
    ).toString('base64url')
    const uri = `offcut://pair/${payload}`
    let qr: string | null = null
    try {
      qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 })
    } catch {
      qr = null
    }
    return { uri, host, port: p.port, addresses, qr }
  })

  ipcMain.handle('sync:unpairAll', () => {
    getPairing().rotateToken()
    return status()
  })

  ipcMain.handle('sync:removeDevice', (_e, id: string) => {
    getPairing().removeDevice(id)
    return status()
  })
}
