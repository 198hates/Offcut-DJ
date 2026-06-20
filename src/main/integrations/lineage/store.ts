import Database from 'better-sqlite3'
import type { Candidate, CandidateStatus, LibraryTrackRef, StoredCandidate } from './types'

// Normalise "Artist - Title" into a fuzzy dedup key so that
// "Floating Points - Silhouettes (Part 1)" and "...Silhouettes" collapse together.
export function dedupKey(artist = '', title = ''): string {
  return `${artist} ${title}`
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // drop (Original Mix), [LABEL001] etc.
    .replace(/\b(feat\.?|featuring|remix|edit|version|mix)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export class LineageStore {
  private db: Database.Database

  /** Release the SQLite handle (engine rebuilds create a fresh store). */
  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library (
        key TEXT PRIMARY KEY                    -- tracks the user already owns
      );
      CREATE TABLE IF NOT EXISTS candidates (
        key           TEXT PRIMARY KEY,
        artist        TEXT,
        title         TEXT,
        label         TEXT,
        year          INTEGER,
        discogs_id    INTEGER,
        why           TEXT,                      -- human-readable reason it surfaced
        score         REAL,
        direction     TEXT,                      -- which branch surfaced it (e.g. person:123 / label:45)
        seed_key      TEXT,                      -- the seed it was discovered from (immediate parent)
        root_seed_key TEXT,                      -- the original seed at the top of the chain
        status        TEXT DEFAULT 'new',        -- new | saved | dismissed
        found_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS http_cache (
        url        TEXT PRIMARY KEY,             -- full request URL
        body       TEXT,                         -- raw JSON response text
        fetched_at INTEGER                       -- epoch ms when cached
      );
    `)
    this.migrate()
  }

  // ── HTTP response cache ──────────────────────────────────────────────────
  // Discogs release/artist/label data is effectively immutable, so caching it
  // makes re-digs (and overlapping seeds) near-instant and spares the rate limit.

  /** Cached response body for `url` if present and younger than `ttlMs`, else null. */
  getCached(url: string, ttlMs: number): string | null {
    const row = this.db
      .prepare('SELECT body, fetched_at FROM http_cache WHERE url = ?')
      .get(url) as { body: string; fetched_at: number } | undefined
    if (!row) return null
    if (Date.now() - row.fetched_at > ttlMs) return null
    return row.body
  }

  putCached(url: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO http_cache (url, body, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`
      )
      .run(url, body, Date.now())
  }

  /** Add the direction/seed_key/root_seed_key columns to pre-existing databases. */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(candidates)').all() as { name: string }[]).map(
        (c) => c.name
      )
    )
    for (const col of ['direction', 'seed_key', 'root_seed_key']) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE candidates ADD COLUMN ${col} TEXT`)
    }
  }

  // Mirror the user's existing tracks in for dedup. Call once at startup
  // and whenever their library changes. tracks: [{ artist, title }, ...]
  loadLibrary(tracks: LibraryTrackRef[] = []): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO library (key) VALUES (?)')
    const tx = this.db.transaction((rows: LibraryTrackRef[]) => {
      for (const t of rows) insert.run(dedupKey(t.artist, t.title))
    })
    tx(tracks)
  }

  owns(artist: string, title: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM library WHERE key = ?').get(dedupKey(artist, title))
  }

  upsertCandidate(c: Candidate): void {
    this.db
      .prepare(
        `
      INSERT INTO candidates
        (key, artist, title, label, year, discogs_id, why, score, direction, seed_key, root_seed_key)
      VALUES
        (@key, @artist, @title, @label, @year, @discogs_id, @why, @score, @direction, @seed_key, @root_seed_key)
      ON CONFLICT(key) DO UPDATE SET
        why   = excluded.why,
        score = MAX(candidates.score, excluded.score)
    `
      )
      // Bind only the columns the statement names — candidates may carry extra
      // in-memory fields (e.g. `owned`) that aren't persisted, and better-sqlite3
      // rejects unknown named parameters.
      .run({
        key: c.key,
        artist: c.artist,
        title: c.title,
        label: c.label ?? null,
        year: c.year ?? null,
        discogs_id: c.discogs_id ?? null,
        why: c.why,
        score: c.score,
        direction: c.direction ?? null,
        seed_key: c.seed_key ?? null,
        root_seed_key: c.root_seed_key ?? null
      })
  }

  listCandidates(status: CandidateStatus = 'new'): StoredCandidate[] {
    return this.db
      .prepare('SELECT * FROM candidates WHERE status = ? ORDER BY score DESC')
      .all(status) as StoredCandidate[]
  }

  setStatus(key: string, status: CandidateStatus): void {
    this.db.prepare('UPDATE candidates SET status = ? WHERE key = ?').run(status, key)
  }
}
