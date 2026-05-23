export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    genre TEXT NOT NULL DEFAULT '',
    bpm REAL,
    key TEXT,
    duration_seconds REAL,
    rating INTEGER NOT NULL DEFAULT 0,
    date_added TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    cue_points TEXT NOT NULL DEFAULT '[]',
    beatgrid TEXT NOT NULL DEFAULT '[]',
    source_ids TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_folder INTEGER NOT NULL DEFAULT 0,
    is_smart INTEGER NOT NULL DEFAULT 0,
    rules TEXT NOT NULL DEFAULT '[]',
    parent_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    source_ids TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, track_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
  CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

  -- Migration: add smart playlist columns if upgrading from older schema
  ALTER TABLE playlists ADD COLUMN is_smart INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE playlists ADD COLUMN rules TEXT NOT NULL DEFAULT '[]';
`

// Run schema with graceful handling of ALTER TABLE on existing columns
export function applySchema(db: import('better-sqlite3').Database): void {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      bpm REAL,
      key TEXT,
      duration_seconds REAL,
      rating INTEGER NOT NULL DEFAULT 0,
      date_added TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      cue_points TEXT NOT NULL DEFAULT '[]',
      beatgrid TEXT NOT NULL DEFAULT '[]',
      source_ids TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_folder INTEGER NOT NULL DEFAULT 0,
      is_smart INTEGER NOT NULL DEFAULT 0,
      rules TEXT NOT NULL DEFAULT '[]',
      parent_id TEXT REFERENCES playlists(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source_ids TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playlist_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
  `)

  // Safe column migrations — ignore "duplicate column" errors
  for (const stmt of [
    "ALTER TABLE playlists ADD COLUMN is_smart INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE playlists ADD COLUMN rules TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE playlists ADD COLUMN color TEXT NOT NULL DEFAULT '#8A8474'",
    "ALTER TABLE tracks ADD COLUMN color TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracks ADD COLUMN energy INTEGER",
    "ALTER TABLE tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracks ADD COLUMN last_played_at TEXT",
    "ALTER TABLE playlists ADD COLUMN is_auto_group INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracks ADD COLUMN danceability REAL",
    "ALTER TABLE tracks ADD COLUMN custom_tags TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE tracks ADD COLUMN mood REAL",
    `CREATE TABLE IF NOT EXISTS play_history (
       id      TEXT PRIMARY KEY,
       track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
       played_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    "CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at)",
    "CREATE INDEX IF NOT EXISTS idx_play_history_track_id  ON play_history(track_id)",
    // Beatgrid v2 — rich analysed grid stored alongside legacy beatgrid array
    "ALTER TABLE tracks ADD COLUMN analysed_beatgrid TEXT",
    // Cut history — extended play event columns
    "ALTER TABLE play_history ADD COLUMN mixed_from TEXT",
    "ALTER TABLE play_history ADD COLUMN mixed_into TEXT",
    "ALTER TABLE play_history ADD COLUMN deck_id   TEXT",
    // Edit lineage — stored on the track
    "ALTER TABLE tracks ADD COLUMN edit_lineage TEXT",
    // Release year and record label
    "ALTER TABLE tracks ADD COLUMN year INTEGER",
    "ALTER TABLE tracks ADD COLUMN label TEXT NOT NULL DEFAULT ''",
    // Running orders — editorial programme documents
    `CREATE TABLE IF NOT EXISTS running_orders (
       id          TEXT PRIMARY KEY,
       catalog_num INTEGER NOT NULL DEFAULT 1,
       title       TEXT NOT NULL DEFAULT '',
       entries     TEXT NOT NULL DEFAULT '[]',
       annotations TEXT NOT NULL DEFAULT '[]',
       created_at  TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    "CREATE INDEX IF NOT EXISTS idx_running_orders_catalog ON running_orders(catalog_num)"
  ]) {
    try { db.exec(stmt) } catch { /* column already exists */ }
  }
}
