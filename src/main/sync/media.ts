// Media serving for the phone companion: precomputed waveform peaks and a
// compressed AAC proxy per track, both cached on disk keyed by content hash so
// the work happens once. The phone renders the peaks and auditions the proxy
// offline, without the (often huge, lossless) source ever leaving the desktop.
//
// The pure pieces (quantise, range parsing, cache-path derivation, db lookup)
// are unit-tested; the ffmpeg generation paths are integration and exercised
// against real hardware.

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import ffmpegPath from 'ffmpeg-static'
import type { Database } from 'better-sqlite3'
import { decodeAudioToPcm } from '../integrations/beat-analysis/audio-decode'
import { computeWaveformBands } from '../integrations/rekordbox-usb/waveform'

/** Compact, phone-ready waveform overview. Bands are quantised to 0..255. */
export interface PeaksData {
  v: 1
  trackId: string
  contentHash: string | null
  buckets: number
  durationSec: number
  peaks: number[]
  low: number[]
  mid: number[]
  high: number[]
}

interface TrackFile {
  trackId: string
  filePath: string
  contentHash: string | null
  durationSec: number
}

const PEAKS_SAMPLE_RATE = 44_100
const PROXY_BITRATE_K = 128

/** Quantise a 0..1 envelope to 0..255 to shrink the JSON payload. */
export function quantize(a: Float32Array): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }
  return out
}

/**
 * Parse an HTTP Range header against a known size. Supports `bytes=start-end`,
 * `bytes=start-` and the `bytes=-suffix` form. Returns null when absent or
 * unsatisfiable (the caller then serves the whole file).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, s, e] = m
  let start: number
  let end: number
  if (s === '') {
    const suffix = parseInt(e, 10)
    if (Number.isNaN(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = parseInt(s, 10)
    end = e === '' ? size - 1 : parseInt(e, 10)
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  if (start < 0 || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Stable key identifying a track's media version. Prefers the content hash (so a
 * re-encode/edit yields a new key and a fresh proxy), falling back to the id.
 * Exported so the Drive publisher keys uploads the same way the LAN cache does.
 */
export function proxyCacheKey(trackId: string, contentHash: string | null): string {
  return contentHash || `id-${trackId.replace(/[^A-Za-z0-9]+/g, '_')}`
}

function cacheKey(info: TrackFile): string {
  return proxyCacheKey(info.trackId, info.contentHash)
}

function peaksCachePath(cacheDir: string, info: TrackFile): string {
  return join(cacheDir, `${cacheKey(info)}.peaks.json`)
}

function proxyCachePath(cacheDir: string, info: TrackFile): string {
  return join(cacheDir, `${cacheKey(info)}.m4a`)
}

function resolveTrackFile(db: Database, trackId: string): TrackFile | null {
  const row = db
    .prepare('SELECT id, file_path, content_hash, duration_seconds FROM tracks WHERE id = ?')
    .get(trackId) as
    | { id: string; file_path: string; content_hash: string | null; duration_seconds: number | null }
    | undefined
  if (!row) return null
  return {
    trackId: row.id,
    filePath: row.file_path,
    contentHash: row.content_hash ?? null,
    durationSec: row.duration_seconds ?? 0
  }
}

async function generatePeaks(info: TrackFile): Promise<PeaksData | null> {
  try {
    const samples = await decodeAudioToPcm(info.filePath, PEAKS_SAMPLE_RATE)
    const seconds = info.durationSec > 0 ? info.durationSec : samples.length / PEAKS_SAMPLE_RATE
    // ~30 columns/sec, clamped — enough detail for a phone overview without bloat.
    const buckets = Math.min(4000, Math.max(200, Math.round(seconds * 30)))
    const bands = computeWaveformBands(samples, PEAKS_SAMPLE_RATE, buckets)
    return {
      v: 1,
      trackId: info.trackId,
      contentHash: info.contentHash,
      buckets,
      durationSec: seconds,
      peaks: quantize(bands.peaks),
      low: quantize(bands.low),
      mid: quantize(bands.mid),
      high: quantize(bands.high)
    }
  } catch {
    return null
  }
}

/** Peaks for a track (cached). Null if the track is unknown or won't decode. */
export async function getPeaks(db: Database, cacheDir: string, trackId: string): Promise<PeaksData | null> {
  const info = resolveTrackFile(db, trackId)
  if (!info) return null
  const file = peaksCachePath(cacheDir, info)
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as PeaksData
    } catch {
      /* corrupt cache — regenerate below */
    }
  }
  const data = await generatePeaks(info)
  if (!data) return null
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data))
  } catch {
    /* serving still works without the cache write */
  }
  return data
}

function transcodeToAac(filePath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not found'))
      return
    }
    mkdirSync(dirname(outPath), { recursive: true })
    const tmp = `${outPath}.tmp.m4a`
    // +faststart moves the moov atom to the front so the phone can seek/stream
    // without downloading the whole file first.
    const proc = spawn(ffmpegPath, [
      '-i', filePath,
      '-vn',
      '-c:a', 'aac',
      '-b:a', `${PROXY_BITRATE_K}k`,
      '-movflags', '+faststart',
      '-y', tmp
    ])
    const tail: string[] = []
    proc.stderr.on('data', (d: Buffer) => {
      tail.push(d.toString())
      if (tail.length > 8) tail.shift()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          /* ignore */
        }
        reject(new Error(`ffmpeg proxy failed (${code}): ${tail.join('').split('\n').slice(-2).join(' ')}`))
        return
      }
      try {
        renameSync(tmp, outPath)
      } catch (e) {
        reject(e as Error)
        return
      }
      resolve()
    })
  })
}

/** Path to a track's AAC proxy (transcoding + caching on first request). */
export async function getProxyPath(db: Database, cacheDir: string, trackId: string): Promise<string | null> {
  const info = resolveTrackFile(db, trackId)
  if (!info) return null
  const out = proxyCachePath(cacheDir, info)
  if (existsSync(out)) return out
  if (!existsSync(info.filePath)) return null
  try {
    await transcodeToAac(info.filePath, out)
    return existsSync(out) ? out : null
  } catch {
    return null
  }
}
