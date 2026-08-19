/**
 * IPC surface for sync-client mode: this machine mirroring another desktop's
 * library so you can manage playlists and metadata away from the machine that
 * holds the audio. See sync/client.ts for the pull/push mechanics.
 */
import { ipcMain, app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { getLibraryDb } from '../library/db'
import { probeHost, pull, push } from '../sync/client'
import type { SyncClientConfig, SyncClientState } from '../sync/client'

interface Persisted extends SyncClientState {
  host: string
  port: number
  token: string
  enabled: boolean
  deviceId: string
  lastPullAt: string | null
  lastPushAt: string | null
  lastError: string | null
}

const DEFAULTS: Persisted = {
  host: '', port: 47823, token: '', enabled: false,
  remoteCursor: 0, pushCursor: 0,
  deviceId: '', lastPullAt: null, lastPushAt: null, lastError: null
}

const file = (): string => join(app.getPath('userData'), 'sync-client.json')

function load(): Persisted {
  try {
    if (existsSync(file())) {
      const j = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Persisted>
      return { ...DEFAULTS, ...j, deviceId: j.deviceId || randomUUID() }
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULTS, deviceId: randomUUID() }
}

function save(s: Persisted): void {
  try { writeFileSync(file(), JSON.stringify(s, null, 2)) } catch { /* non-fatal */ }
}

/** Never hand the bearer token to the renderer; it only needs to know if one is set. */
const redact = (s: Persisted): Omit<Persisted, 'token'> & { hasToken: boolean } => {
  const { token, ...rest } = s
  return { ...rest, hasToken: token.length > 0 }
}

const configOf = (s: Persisted): SyncClientConfig => ({ host: s.host, port: s.port, token: s.token })

export function registerSyncClientHandlers(): void {
  let state = load()
  const deviceName = `Offcut on ${hostname()}`

  ipcMain.handle('syncClient:status', () => redact(state))

  ipcMain.handle('syncClient:configure', (_e, cfg: { host: string; port?: number; token?: string; enabled?: boolean }) => {
    state = {
      ...state,
      host: cfg.host.trim(),
      port: cfg.port ?? state.port,
      token: cfg.token?.trim() || state.token,
      enabled: cfg.enabled ?? state.enabled
    }
    save(state)
    return redact(state)
  })

  /**
   * Accepts the `offcut://pair/<base64url>` URI from the host's pairing screen,
   * so the whole host+port+token triple arrives in one paste rather than three
   * fields typed by hand.
   */
  ipcMain.handle('syncClient:pairFromUri', (_e, uri: string) => {
    try {
      const b64 = uri.replace(/^offcut:\/\/pair\//, '').trim()
      const json = Buffer.from(b64, 'base64url').toString('utf8')
      const p = JSON.parse(json) as { host?: string; port?: number; token?: string }
      if (!p.host || !p.port || !p.token) throw new Error('missing host, port or token')
      state = { ...state, host: p.host, port: p.port, token: p.token, enabled: true }
      save(state)
      return { ok: true, status: redact(state) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('syncClient:probe', async () => probeHost({ host: state.host, port: state.port }))

  ipcMain.handle('syncClient:pull', async () => {
    if (!state.host || !state.token) return { ok: false, error: 'not configured' }
    try {
      const { result, state: next } = await pull(
        getLibraryDb(), configOf(state), state, state.deviceId, deviceName
      )
      state = { ...state, ...next, lastPullAt: new Date().toISOString(), lastError: null }
      save(state)
      return { ok: true, result, status: redact(state) }
    } catch (err) {
      state = { ...state, lastError: (err as Error).message }
      save(state)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('syncClient:push', async () => {
    if (!state.host || !state.token) return { ok: false, error: 'not configured' }
    try {
      const { result, state: next } = await push(
        getLibraryDb(), configOf(state), state, state.deviceId, deviceName
      )
      state = { ...state, ...next, lastPushAt: new Date().toISOString(), lastError: null }
      save(state)
      return { ok: true, result, status: redact(state) }
    } catch (err) {
      state = { ...state, lastError: (err as Error).message }
      save(state)
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Push local edits first, then pull — so a conflict resolves in the host's favour. */
  ipcMain.handle('syncClient:syncNow', async () => {
    if (!state.host || !state.token) return { ok: false, error: 'not configured' }
    try {
      const pushed = await push(getLibraryDb(), configOf(state), state, state.deviceId, deviceName)
      state = { ...state, ...pushed.state, lastPushAt: new Date().toISOString() }
      const pulled = await pull(getLibraryDb(), configOf(state), state, state.deviceId, deviceName)
      state = { ...state, ...pulled.state, lastPullAt: new Date().toISOString(), lastError: null }
      save(state)
      return { ok: true, pushed: pushed.result, pulled: pulled.result, status: redact(state) }
    } catch (err) {
      state = { ...state, lastError: (err as Error).message }
      save(state)
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Forget the host and start over — also resets cursors so the next pull is a full snapshot. */
  ipcMain.handle('syncClient:reset', () => {
    state = { ...DEFAULTS, deviceId: state.deviceId }
    save(state)
    return redact(state)
  })
}
