// Google Cast — de-risking slice.
//
// Casting a live DJ mix means the device must PULL a stream (Cast can't receive
// a live audio push from a non-Chrome app). So the flow is:
//   1. discover Cast devices over mDNS (_googlecast._tcp)
//   2. encode an audio source to live HLS with the bundled ffmpeg
//   3. serve that HLS over a tiny local HTTP server on the LAN
//   4. tell the device (via the Cast v2 protocol) to load that URL
//
// This slice proves the whole chain on real hardware using a chosen audio FILE
// as the source. Wiring the live MASTER MIX (via the engine's recorder tap) in
// place of the file is the planned follow-on once the chain is confirmed.

import { ipcMain } from 'electron'
import { Bonjour } from 'bonjour-service'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, existsSync, rmSync, createReadStream } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join, basename } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { CastDevice, CastStatus } from '../../shared/types'

// castv2-client ships no types — it's a small callback-style protocol client.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client, DefaultMediaReceiver } = require('castv2-client')

let _server: Server | null = null
let _ff: ChildProcess | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null
let _hlsDir: string | null = null
let _status: CastStatus = { casting: false, device: null, source: null, error: null }

/** A LAN IPv4 the Chromecast can reach back on (not loopback). */
function lanIp(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

/** Browse mDNS for Cast devices for `timeoutMs`, returning what was found. */
export function discover(timeoutMs = 4000): Promise<CastDevice[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour()
    const found = new Map<string, CastDevice>()
    const browser = bonjour.find({ type: 'googlecast' }, (svc) => {
      const host = svc.addresses?.find((a) => a.includes('.')) ?? svc.host
      if (!host) return
      const txt = (svc.txt ?? {}) as Record<string, string>
      found.set(host, { name: txt.fn || svc.name || host, host, port: svc.port || 8009, id: txt.id || host })
    })
    setTimeout(() => {
      try { browser.stop() } catch { /* ignore */ }
      try { bonjour.destroy() } catch { /* ignore */ }
      resolve([...found.values()])
    }, timeoutMs)
  })
}

/** Wait until `file` exists (the ffmpeg playlist), or reject after `timeoutMs`. */
function waitForFile(file: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (existsSync(file)) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('ffmpeg produced no HLS playlist'))
      setTimeout(tick, 150)
    }
    tick()
  })
}

/** Encode `sourceFile` to live HLS and serve it; returns the playable URL. */
async function startHlsServer(sourceFile: string): Promise<string> {
  _hlsDir = mkdtempSync(join(tmpdir(), 'offcut-cast-'))
  const playlist = join(_hlsDir, 'stream.m3u8')

  // -re reads the input at native rate (so HLS stays "live"); a small sliding
  // window with delete_segments keeps disk + latency bounded.
  _ff = spawn(ffmpegPath as unknown as string, [
    '-hide_banner', '-loglevel', 'error',
    '-re', '-i', sourceFile,
    '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', join(_hlsDir, 'seg%03d.ts'),
    playlist
  ])
  _ff.on('error', (e) => { _status.error = `ffmpeg: ${e.message}` })

  await waitForFile(playlist, 8000)

  _server = createServer((req, res) => {
    const name = basename((req.url || '/').split('?')[0]) || 'stream.m3u8'
    const file = join(_hlsDir as string, name)
    if (!file.startsWith(_hlsDir as string) || !existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Access-Control-Allow-Origin': '*'
    })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => _server!.listen(0, r))
  const addr = _server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return `http://${lanIp()}:${port}/stream.m3u8`
}

/** Start casting `sourceFile` to `device`. Tears down any existing session first. */
export async function startCast(device: CastDevice, sourceFile: string): Promise<void> {
  await stopCast()
  if (!existsSync(sourceFile)) throw new Error('source file not found')
  const url = await startHlsServer(sourceFile)

  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = new Client()
    _client = client
    client.on('error', (e: Error) => {
      _status.error = e.message
      try { client.close() } catch { /* ignore */ }
    })
    client.connect(device.host, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.launch(DefaultMediaReceiver, (err: Error | null, player: any) => {
        if (err) return reject(err)
        const media = {
          contentId: url,
          contentType: 'application/vnd.apple.mpegurl',
          streamType: 'LIVE',
          metadata: { type: 0, metadataType: 0, title: `Offcut · ${basename(sourceFile)}` }
        }
        player.load(media, { autoplay: true }, (err2: Error | null) => {
          if (err2) return reject(err2)
          _status = { casting: true, device: device.name, source: sourceFile, error: null }
          resolve()
        })
      })
    })
  })
}

/** Stop casting and free the encoder, server and temp segments. */
export async function stopCast(): Promise<void> {
  try { _client?.close?.() } catch { /* ignore */ }
  _client = null
  if (_ff) { _ff.kill('SIGKILL'); _ff = null }
  if (_server) { _server.close(); _server = null }
  if (_hlsDir) {
    try { rmSync(_hlsDir, { recursive: true, force: true }) } catch { /* ignore */ }
    _hlsDir = null
  }
  _status = { casting: false, device: null, source: null, error: _status.error }
}

export function castStatus(): CastStatus {
  return _status
}

export function registerCastHandlers(): void {
  ipcMain.handle('cast:discover', () => discover())
  ipcMain.handle('cast:start', (_e, device: CastDevice, sourceFile: string) => startCast(device, sourceFile))
  ipcMain.handle('cast:stop', () => stopCast())
  ipcMain.handle('cast:status', () => castStatus())
}
