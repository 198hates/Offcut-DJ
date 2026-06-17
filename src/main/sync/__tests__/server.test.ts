import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSyncRequest, SyncServer, type RouteDeps } from '../server'
import { PairingStore } from '../pairing'
import type { SyncPull } from '../../../shared/types'

const emptyPull: SyncPull = { cursor: 0, tracks: [], playlists: [], deletedTrackIds: [], deletedPlaylistIds: [] }

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    verify: (t) => t === 'good',
    pull: () => emptyPull,
    recordDevice: () => undefined,
    info: () => ({ name: 'Offcut', version: '1.2.3' }),
    ...over
  }
}

function q(s = ''): URLSearchParams {
  return new URLSearchParams(s)
}

describe('handleSyncRequest', () => {
  it('serves /health without auth', () => {
    const r = handleSyncRequest('GET', '/health', q(), {}, deps())
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, name: 'Offcut', version: '1.2.3' })
  })

  it('rejects /sync/* without a valid token', () => {
    expect(handleSyncRequest('GET', '/sync/pull', q(), {}, deps()).status).toBe(401)
    expect(
      handleSyncRequest('GET', '/sync/pull', q(), { authorization: 'Bearer nope' }, deps()).status
    ).toBe(401)
  })

  it('serves the pull with a valid token and parses the cursor', () => {
    let askedCursor = -1
    const r = handleSyncRequest(
      'GET',
      '/sync/pull',
      q('cursor=42'),
      { authorization: 'Bearer good' },
      deps({ pull: (c) => ((askedCursor = c), { ...emptyPull, cursor: c }) })
    )
    expect(r.status).toBe(200)
    expect(askedCursor).toBe(42)
  })

  it('records the connecting device from headers', () => {
    let seen: { id: string | null; name: string | null } | null = null
    handleSyncRequest(
      'GET',
      '/sync/pull',
      q(),
      { authorization: 'Bearer good', 'x-device-id': 'phone1', 'x-device-name': 'Nathan iPhone' },
      deps({ recordDevice: (id, name) => (seen = { id, name }) })
    )
    expect(seen).toEqual({ id: 'phone1', name: 'Nathan iPhone' })
  })

  it('404s unknown sync routes (still requires auth first)', () => {
    expect(handleSyncRequest('GET', '/sync/bogus', q(), { authorization: 'Bearer good' }, deps()).status).toBe(404)
  })
})

describe('SyncServer round-trip', () => {
  it('answers real HTTP requests with token auth', async () => {
    const srv = new SyncServer(deps({ pull: () => ({ ...emptyPull, cursor: 7 }) }))
    await srv.start(0) // ephemeral port
    const port = srv.port!
    expect(port).toBeGreaterThan(0)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      expect(health.status).toBe(200)

      const noauth = await fetch(`http://127.0.0.1:${port}/sync/pull`)
      expect(noauth.status).toBe(401)

      const ok = await fetch(`http://127.0.0.1:${port}/sync/pull?cursor=0`, {
        headers: { authorization: 'Bearer good' }
      })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ cursor: 7 })
    } finally {
      await srv.stop()
    }
    expect(srv.running).toBe(false)
  })
})

describe('PairingStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offcut-pair-'))
  })

  it('persists a token and verifies it constant-time', () => {
    const file = join(dir, 'pairing.json')
    const p = new PairingStore(file)
    expect(p.token).toHaveLength(32) // 24 bytes base64url
    expect(p.verify(p.token)).toBe(true)
    expect(p.verify('wrong')).toBe(false)
    expect(p.verify(null)).toBe(false)

    // Reloads the same token from disk.
    expect(new PairingStore(file).token).toBe(p.token)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rotating the token unpairs all devices', () => {
    const p = new PairingStore(join(dir, 'pairing.json'))
    p.recordDevice('d1', 'Phone')
    const old = p.token
    expect(p.devices).toHaveLength(1)
    p.rotateToken()
    expect(p.token).not.toBe(old)
    expect(p.verify(old)).toBe(false)
    expect(p.devices).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('records and removes devices, updating lastSeen', () => {
    const p = new PairingStore(join(dir, 'pairing.json'))
    p.recordDevice('d1', 'Phone')
    const first = p.devices[0].lastSeen
    p.recordDevice('d1', 'Phone Renamed')
    expect(p.devices).toHaveLength(1)
    expect(p.devices[0].name).toBe('Phone Renamed')
    expect(p.devices[0].lastSeen >= first).toBe(true)
    p.removeDevice('d1')
    expect(p.devices).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
