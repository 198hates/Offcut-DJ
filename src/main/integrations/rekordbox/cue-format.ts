/**
 * Value formats rekordbox expects in djmdCue.
 *
 * Both exist because the export previously wrote neither, and every track with
 * cue points failed on "NOT NULL constraint failed: djmdCue.created_at" — a
 * silent, total failure of cue sync that still reported partial success.
 */
import { randomUUID } from 'crypto'

/**
 * rekordbox stores timestamps as `2024-07-21 14:01:03.943 +00:00` — millisecond
 * precision with an explicit UTC offset, which is NOT what SQLite's
 * datetime('now') produces (`2024-07-21 14:01:03`). Matching the real format
 * keeps rows indistinguishable from rekordbox's own.
 */
export function rbTimestamp(now: Date = new Date()): string {
  const iso = now.toISOString()              // 2024-07-21T14:01:03.943Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} +00:00`
}

/**
 * djmdCue.ID is a VARCHAR primary key holding a 10-digit numeric string.
 * SQLite generates nothing for a non-INTEGER primary key, and — a long-standing
 * quirk — permits multiple NULLs in one, so omitting it writes cues with null
 * ids that look fine until something tries to reference them.
 */
export function newCueId(rand: () => number = Math.random): string {
  // 10 digits, never leading-zero, matching the observed id shape.
  return String(Math.floor(rand() * 9_000_000_000) + 1_000_000_000)
}

export { randomUUID }
