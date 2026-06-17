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
    "CREATE INDEX IF NOT EXISTS idx_running_orders_catalog ON running_orders(catalog_num)",
    // File-level metadata
    "ALTER TABLE tracks ADD COLUMN file_size INTEGER",
    "ALTER TABLE tracks ADD COLUMN file_type TEXT",
    "ALTER TABLE tracks ADD COLUMN sample_rate INTEGER",
    "ALTER TABLE tracks ADD COLUMN bit_depth INTEGER",
    // Per-track gain trim (LUFS-based auto-gain)
    "ALTER TABLE tracks ADD COLUMN gain_db REAL",
    // Phrase / song structure
    "ALTER TABLE tracks ADD COLUMN phrases TEXT",
    // Audio-content feature vector (similarity)
    "ALTER TABLE tracks ADD COLUMN embedding TEXT",
    // Date last modified (tag write-back timestamp)
    "ALTER TABLE tracks ADD COLUMN updated_at TEXT",
    // Session history playlist type
    "ALTER TABLE playlists ADD COLUMN is_history INTEGER NOT NULL DEFAULT 0",

    // ── Library sync (mobile companion / multi-device) ──────────────────────
    // Content hash gives a file a stable identity across devices, so the same
    // track reconciles even though primary keys are library-local.
    "ALTER TABLE tracks ADD COLUMN content_hash TEXT",
    "CREATE INDEX IF NOT EXISTS idx_tracks_content_hash ON tracks(content_hash)",
    // Append-only change journal. The autoincrement seq is the sync cursor; a
    // 'delete' row is the tombstone for a hard-deleted entity.
    `CREATE TABLE IF NOT EXISTS sync_log (
       seq        INTEGER PRIMARY KEY AUTOINCREMENT,
       entity     TEXT NOT NULL,
       entity_id  TEXT NOT NULL,
       op         TEXT NOT NULL,
       changed_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    // Triggers journal every write regardless of which code path made it.
    `CREATE TRIGGER IF NOT EXISTS sync_tracks_ai AFTER INSERT ON tracks BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('track', NEW.id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_tracks_au AFTER UPDATE ON tracks BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('track', NEW.id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_tracks_ad AFTER DELETE ON tracks BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('track', OLD.id, 'delete');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_playlists_ai AFTER INSERT ON playlists BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', NEW.id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_playlists_au AFTER UPDATE ON playlists BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', NEW.id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_playlists_ad AFTER DELETE ON playlists BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', OLD.id, 'delete');
     END`,
    // Membership changes mark the owning playlist dirty. The WHEN guard skips
    // cascade-deletes of an already-removed playlist, so a deleted playlist is
    // never resurrected by a later 'upsert' from its vanishing rows.
    `CREATE TRIGGER IF NOT EXISTS sync_pltrk_ai AFTER INSERT ON playlist_tracks BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', NEW.playlist_id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_pltrk_au AFTER UPDATE ON playlist_tracks BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', NEW.playlist_id, 'upsert');
     END`,
    `CREATE TRIGGER IF NOT EXISTS sync_pltrk_ad AFTER DELETE ON playlist_tracks
       WHEN EXISTS (SELECT 1 FROM playlists WHERE id = OLD.playlist_id) BEGIN
       INSERT INTO sync_log(entity, entity_id, op) VALUES ('playlist', OLD.playlist_id, 'upsert');
     END`
  ]) {
    try {
      db.exec(stmt)
    } catch (e) {
      // Only "already exists" is expected — swallowing every error here let
      // real migration failures (disk full, locked DB, syntax) pass silently
      // and surface later as missing-column crashes.
      if (!/duplicate column|already exists/i.test((e as Error).message)) throw e
    }
  }
}
