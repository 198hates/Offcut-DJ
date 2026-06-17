// LAN sync server for the phone companion.
//
// Plain Node http (no extra transport dependency). The routing + auth is a pure
// function (handleSyncRequest) so it's unit-testable with fake deps; SyncServer
// is just the socket adapter around it. Read-only for now: it serves the delta
// pull. Pushing edits from the phone is the next slice.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { SyncPull } from '../../shared/types'

export interface RouteDeps {
  /** Validate the request's bearer token. */
  verify: (token: string | null) => boolean
  /** Produce the delta/snapshot for a cursor. */
  pull: (cursor: number) => SyncPull
  /** Note that a device connected (for the desktop's device list). */
  recordDevice: (id: string | null, name: string | null) => void
  /** Public server identity, returned by /health. */
  info: () => { name: string; version: string }
}

export interface RouteResult {
  status: number
  json: unknown
}

function bearer(auth: string | undefined): string | null {
  if (!auth) return null
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m ? m[1].trim() : null
}

/**
 * Route a request. `/health` is open (so a phone can sanity-check the address);
 * everything under `/sync/` requires a valid bearer token.
 */
export function handleSyncRequest(
  method: string | undefined,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  deps: RouteDeps
): RouteResult {
  const header = (k: string): string | undefined => {
    const v = headers[k]
    return Array.isArray(v) ? v[0] : v
  }

  if (method === 'GET' && path === '/health') {
    return { status: 200, json: { ok: true, ...deps.info() } }
  }

  if (path.startsWith('/sync/')) {
    if (!deps.verify(bearer(header('authorization')))) {
      return { status: 401, json: { error: 'unauthorized' } }
    }
    deps.recordDevice(header('x-device-id') ?? null, header('x-device-name') ?? null)

    if (method === 'GET' && path === '/sync/pull') {
      const cursor = Math.max(0, Math.floor(Number(query.get('cursor') ?? 0)) || 0)
      return { status: 200, json: deps.pull(cursor) }
    }
    return { status: 404, json: { error: 'not found' } }
  }

  return { status: 404, json: { error: 'not found' } }
}

export class SyncServer {
  private server: Server | null = null

  constructor(private deps: RouteDeps) {}

  get running(): boolean {
    return this.server !== null
  }

  /** The bound port, or null when stopped. */
  get port(): number | null {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? (addr as AddressInfo).port : null
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) return resolve()
      const srv = createServer((req, res) => this.onRequest(req, res))
      srv.once('error', (e) => {
        this.server = null
        reject(e)
      })
      srv.listen(port, '0.0.0.0', () => {
        this.server = srv
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let result: RouteResult
    try {
      result = handleSyncRequest(req.method, url.pathname, url.searchParams, req.headers, this.deps)
    } catch (e) {
      result = { status: 500, json: { error: (e as Error).message } }
    }
    const body = JSON.stringify(result.json)
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }
}
