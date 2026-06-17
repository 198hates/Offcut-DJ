// Stable cross-device identity for an audio file.
//
// Library primary keys are local to one install, so the same file imported on a
// laptop and a phone gets different ids. A content hash lets the two reconcile.
// We hash file size + the first and last 64 KB rather than the whole file: that
// is effectively instant, survives metadata (ID3) rewrites that only touch the
// head, and is specific enough that distinct tracks never collide in practice.

import { createHash } from 'crypto'
import { openSync, readSync, fstatSync, closeSync } from 'fs'
import { open } from 'fs/promises'
import type { Database } from 'better-sqlite3'

const CHUNK = 64 * 1024

/** Content hash for a file, or null if it can't be read. */
export function computeContentHash(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const { size } = fstatSync(fd)
    const h = createHash('sha1').update(String(size))

    const headLen = Math.min(CHUNK, size)
    if (headLen > 0) {
      const head = Buffer.allocUnsafe(headLen)
      readSync(fd, head, 0, headLen, 0)
      h.update(head)
    }
    // Only hash a distinct tail when the file is bigger than one chunk.
    if (size > CHUNK) {
      const tailLen = Math.min(CHUNK, size - CHUNK)
      const tail = Buffer.allocUnsafe(tailLen)
      readSync(fd, tail, 0, tailLen, size - tailLen)
      h.update(tail)
    }
    return h.digest('hex')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Async sibling of {@link computeContentHash}. Uses non-blocking fs/promises
 * reads so a slow file (e.g. a dehydrated cloud-drive placeholder being pulled
 * down) never freezes the Electron main-process event loop while we wait on it.
 */
export async function computeContentHashAsync(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const { size } = await fh.stat()
    const h = createHash('sha1').update(String(size))

    const headLen = Math.min(CHUNK, size)
    if (headLen > 0) {
      const head = Buffer.allocUnsafe(headLen)
      await fh.read(head, 0, headLen, 0)
      h.update(head)
    }
    if (size > CHUNK) {
      const tailLen = Math.min(CHUNK, size - CHUNK)
      const tail = Buffer.allocUnsafe(tailLen)
      await fh.read(tail, 0, tailLen, size - tailLen)
      h.update(tail)
    }
    return h.digest('hex')
  } catch {
    return null
  } finally {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Fill in content_hash for any tracks that don't have one yet. Runs lazily (not
 * in the import hot path) — call it before a sync, or on idle. Returns how many
 * rows were considered and how many were successfully hashed.
 */
export function backfillContentHashes(db: Database, limit?: number): { processed: number; hashed: number } {
  const rows = db
    .prepare(
      `SELECT id, file_path FROM tracks WHERE content_hash IS NULL${limit ? ' LIMIT ' + Math.floor(limit) : ''}`
    )
    .all() as { id: string; file_path: string }[]

  const update = db.prepare('UPDATE tracks SET content_hash = ? WHERE id = ?')
  let hashed = 0
  const run = db.transaction((items: { id: string; file_path: string }[]) => {
    for (const r of items) {
      const hash = computeContentHash(r.file_path)
      if (hash) {
        update.run(hash, r.id)
        hashed++
      }
    }
  })
  run(rows)
  return { processed: rows.length, hashed }
}

/**
 * Background-friendly variant of {@link backfillContentHashes}.
 *
 * The synchronous version holds a single write transaction across hundreds of
 * file reads — fine for a CLI, fatal in Electron's main process: it freezes the
 * event loop (so /health, IPC and audio all stall) for as long as the disk
 * reads take, which on a cloud-synced drive can be a minute or more. This one:
 *  - reads/hashes each file OUTSIDE any DB transaction (no lock held on slow I/O),
 *  - yields to the event loop after every file (await setImmediate),
 *  - flushes hashes to the DB in small batched transactions,
 *  - stops early if `shouldStop()` goes true (e.g. the server was disabled).
 * Call it detached (don't await it in a request handler).
 */
export async function backfillContentHashesChunked(
  db: Database,
  opts: { batch?: number; max?: number; shouldStop?: () => boolean } = {}
): Promise<{ processed: number; hashed: number }> {
  const batchSize = Math.max(1, opts.batch ?? 25)
  const rows = db
    .prepare(
      `SELECT id, file_path FROM tracks WHERE content_hash IS NULL${opts.max ? ' LIMIT ' + Math.floor(opts.max) : ''}`
    )
    .all() as { id: string; file_path: string }[]

  const update = db.prepare('UPDATE tracks SET content_hash = ? WHERE id = ?')
  const flush = db.transaction((items: { id: string; hash: string }[]) => {
    for (const it of items) update.run(it.hash, it.id)
  })

  let processed = 0
  let hashed = 0
  let pending: { id: string; hash: string }[] = []
  for (const r of rows) {
    if (opts.shouldStop?.()) break
    // Async read: the event loop is free to serve /health, pulls and audio
    // streaming while a slow (cloud-hydrating) file is being pulled down.
    const hash = await computeContentHashAsync(r.file_path)
    processed++
    if (hash) {
      pending.push({ id: r.id, hash })
      hashed++
    }
    if (pending.length >= batchSize) {
      flush(pending)
      pending = []
    }
  }
  if (pending.length) flush(pending)
  return { processed, hashed }
}
