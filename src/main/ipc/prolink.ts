/**
 * IPC handlers for ProLink B2B capture.
 *
 * Push events (status updates, captured tracks) are sent to the renderer via
 * webContents.send — the same pattern used by library:watchFolderAdded.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { ProLinkCapture, listNetworkInterfaces } from '../integrations/prolink/capture'
import type { PlayerStatus, CapturedTrack } from '../../shared/types'

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
      }
      return { ok: true }
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
}
