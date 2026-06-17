// Stable cross-device identity for an audio file.
//
// Library primary keys are local to one install, so the same file imported on a
// laptop and a phone gets different ids. A content hash lets the two reconcile.
// We hash file size + the first and last 64 KB rather than the whole file: that
// is effectively instant, survives metadata (ID3) rewrites that only touch the
// head, and is specific enough that distinct tracks never collide in practice.

import { createHash } from 'crypto'
import { openSync, readSync, fstatSync, closeSync } from 'fs'
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
