// Thin client for the desktop phone-sync API. See /MOBILE_COMPANION_PLAN.md §2.
// Every /sync and /media call carries the bearer token; /health is open.

import type { Connection } from './pairing'
import type { PeaksData, SyncPull, SyncPushPayload, SyncPushResult } from './sync-types'

export interface HealthInfo {
  ok: boolean
  name: string
  version: string
}

/** A stable per-install device id/name, sent so the desktop can list us. */
export interface DeviceIdentity {
  id: string
  name: string
}

export class SyncClient {
  private readonly base: string

  constructor(private readonly conn: Connection, private readonly device?: DeviceIdentity) {
    this.base = `http://${conn.host}:${conn.port}`
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.conn.token}` }
    if (this.device) {
      h['X-Device-Id'] = this.device.id
      h['X-Device-Name'] = this.device.name
    }
    return h
  }

  /** Unauthenticated reachability + identity check. Throws on network failure. */
  async health(timeoutMs = 5000): Promise<HealthInfo> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.base}/health`, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`health ${res.status}`)
      return (await res.json()) as HealthInfo
    } finally {
      clearTimeout(t)
    }
  }

  /** GET /sync/pull?cursor=N — full snapshot at cursor 0, deltas thereafter. */
  async pull(cursor: number): Promise<SyncPull> {
    const res = await fetch(`${this.base}/sync/pull?cursor=${cursor}`, { headers: this.headers() })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) throw new Error(`pull ${res.status}`)
    return (await res.json()) as SyncPull
  }

  /** POST /sync/push — apply local edits (last-writer-wins desktop-side). */
  async push(payload: SyncPushPayload): Promise<SyncPushResult> {
    const res = await fetch(`${this.base}/sync/push`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) throw new Error(`push ${res.status}`)
    return (await res.json()) as SyncPushResult
  }

  /** GET /media/peaks — precomputed waveform bands (0..255). */
  async peaks(trackId: string): Promise<PeaksData> {
    const res = await fetch(`${this.base}/media/peaks?track=${encodeURIComponent(trackId)}`, {
      headers: this.headers()
    })
    if (res.status === 401) throw new UnauthorizedError()
    if (!res.ok) throw new Error(`peaks ${res.status}`)
    return (await res.json()) as PeaksData
  }

  /** URL + auth headers for the AAC proxy (supports Range). Feed both to the
   *  audio player — react-native-track-player accepts a `headers` field, so the
   *  bearer token goes in the header the desktop expects (not the query). */
  proxyRequest(trackId: string): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.base}/media/proxy?track=${encodeURIComponent(trackId)}`,
      headers: { Authorization: `Bearer ${this.conn.token}` }
    }
  }
}

/** Thrown when the desktop rotated its token — the UI should re-pair. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized — re-pair required')
    this.name = 'UnauthorizedError'
  }
}
