// LAN sync server for the phone companion.
//
// Plain Node http (no extra transport dependency). The routing + auth is a pure
// function (handleSyncRequest) so it's unit-testable with fake deps; SyncServer
// is just the socket adapter around it. Read-only for now: it serves the delta
// pull. Pushing edits from the phone is the next slice.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { createReadStream, statSync } from 'fs'
import type { AddressInfo } from 'net'
import type { SyncPull, SyncPushPayload, SyncPushResult } from '../../shared/types'
import { parseRange } from './media'

/** Reject bodies larger than this to avoid a memory-exhaustion vector. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

export interface RouteDeps {
  /** Validate the request's bearer token. */
  verify: (token: string | null) => boolean
  /** Produce the delta/snapshot for a cursor. */
  pull: (cursor: number) => SyncPull
  /** Apply edits pushed from the phone. */
  applyPush: (payload: SyncPushPayload) => SyncPushResult
  /** Waveform peaks JSON for a track, or null if unavailable. */
  getPeaks: (trackId: string) => Promise<unknown | null>
  /** Filesystem path to a track's AAC proxy, or null if unavailable. */
  getProxyPath: (trackId: string) => Promise<string | null>
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
  deps: RouteDeps,
  body?: unknown
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
    if (method === 'POST' && path === '/sync/push') {
      if (typeof body !== 'object' || body === null) {
        return { status: 400, json: { error: 'invalid body' } }
      }
      return { status: 200, json: deps.applyPush(body as SyncPushPayload) }
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
    // Media is async + binary (and needs range streaming), so it's handled
    // outside the pure JSON router.
    if (url.pathname.startsWith('/media/')) {
      void this.handleMedia(req, res, url)
      return
    }
    const needsBody = req.method === 'POST' || req.method === 'PUT'
    if (!needsBody) {
      this.respond(res, this.route(req, url, undefined))
      return
    }
    // Buffer the request body (capped), then route.
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        this.respond(res, { status: 413, json: { error: 'payload too large' } })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let body: unknown
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      } catch {
        this.respond(res, { status: 400, json: { error: 'invalid json' } })
        return
      }
      this.respond(res, this.route(req, url, body))
    })
  }

  private route(req: IncomingMessage, url: URL, body: unknown): RouteResult {
    try {
      return handleSyncRequest(req.method, url.pathname, url.searchParams, req.headers, this.deps, body)
    } catch (e) {
      return { status: 500, json: { error: (e as Error).message } }
    }
  }

  private respond(res: ServerResponse, result: RouteResult): void {
    const body = JSON.stringify(result.json)
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  private async handleMedia(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Media accepts the token via the Authorization header OR a ?token= query —
    // audio players (expo-audio etc.) stream from a bare URL and can't set headers.
    const auth = req.headers.authorization
    const headerToken = bearer(Array.isArray(auth) ? auth[0] : auth)
    const queryToken = url.searchParams.get('token')
    if (!this.deps.verify(headerToken) && !this.deps.verify(queryToken)) {
      this.respond(res, { status: 401, json: { error: 'unauthorized' } })
      return
    }
    const id = (h: string): string | null => {
      const v = req.headers[h]
      return (Array.isArray(v) ? v[0] : v) ?? null
    }
    this.deps.recordDevice(id('x-device-id'), id('x-device-name'))

    if (req.method !== 'GET') {
      this.respond(res, { status: 404, json: { error: 'not found' } })
      return
    }
    const trackId = url.searchParams.get('track') ?? ''
    try {
      if (url.pathname === '/media/peaks') {
        const data = await this.deps.getPeaks(trackId)
        if (!data) {
          this.respond(res, { status: 404, json: { error: 'not found' } })
          return
        }
        this.respond(res, { status: 200, json: data })
        return
      }
      if (url.pathname === '/media/proxy') {
        const path = await this.deps.getProxyPath(trackId)
        if (!path) {
          this.respond(res, { status: 404, json: { error: 'not found' } })
          return
        }
        this.streamFile(res, path, Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range)
        return
      }
      this.respond(res, { status: 404, json: { error: 'not found' } })
    } catch (e) {
      this.respond(res, { status: 500, json: { error: (e as Error).message } })
    }
  }

  /** Stream a file as audio/mp4 with HTTP range support (206 for partials). */
  private streamFile(res: ServerResponse, path: string, rangeHeader: string | undefined): void {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      this.respond(res, { status: 404, json: { error: 'not found' } })
      return
    }
    const type = 'audio/mp4'
    const range = parseRange(rangeHeader, size)
    if (range) {
      const { start, end } = range
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1
      })
      createReadStream(path, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size })
      createReadStream(path).pipe(res)
    }
  }
}
