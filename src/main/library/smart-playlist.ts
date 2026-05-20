import type Database from 'better-sqlite3'
import type { SmartRule, Track } from '../../shared/types'
import { rowToTrack } from './db'

/**
 * Resolves a smart playlist's rules into a list of matching track IDs.
 * Rules are AND-combined. Each rule filters on a track field.
 */
export function resolveSmartPlaylist(db: Database.Database, rules: SmartRule[]): string[] {
  if (rules.length === 0) {
    return (db.prepare('SELECT id FROM tracks ORDER BY artist, title').all() as { id: string }[]).map(r => r.id)
  }

  const clauses: string[] = []
  const params: (string | number)[] = []

  for (const rule of rules) {
    const col = fieldToColumn(rule.field)
    if (!col) continue

    switch (rule.op) {
      case 'is':
        clauses.push(`lower(${col}) = lower(?)`)
        params.push(String(rule.value))
        break
      case 'is_not':
        clauses.push(`lower(${col}) != lower(?)`)
        params.push(String(rule.value))
        break
      case 'contains':
        clauses.push(`${col} LIKE ? COLLATE NOCASE`)
        params.push(`%${rule.value}%`)
        break
      case 'not_contains':
        clauses.push(`${col} NOT LIKE ? COLLATE NOCASE`)
        params.push(`%${rule.value}%`)
        break
      case 'greater_than':
        clauses.push(`${col} > ?`)
        params.push(Number(rule.value))
        break
      case 'less_than':
        clauses.push(`${col} < ?`)
        params.push(Number(rule.value))
        break
      case 'between': {
        const [lo, hi] = rule.value as [number, number]
        clauses.push(`${col} BETWEEN ? AND ?`)
        params.push(lo, hi)
        break
      }
      case 'in_last_days':
        clauses.push(`${col} >= datetime('now', ? || ' days')`)
        params.push(`-${Number(rule.value)}`)
        break
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT id FROM tracks ${where} ORDER BY artist, title`).all(...params) as { id: string }[]
  return rows.map(r => r.id)
}

export function resolveSmartPlaylistTracks(db: Database.Database, rules: SmartRule[]): Track[] {
  const ids = resolveSmartPlaylist(db, rules)
  if (ids.length === 0) return []
  const ph = ids.map(() => '?').join(',')
  return (db.prepare(`SELECT * FROM tracks WHERE id IN (${ph})`).all(...ids) as Record<string, unknown>[]).map(rowToTrack)
}

const COL_MAP: Partial<Record<string, string>> = {
  bpm: 'bpm',
  rating: 'rating',
  durationSeconds: 'duration_seconds',
  dateAdded: 'date_added',
  playCount: 'play_count',
  lastPlayedAt: 'last_played_at',
  title: 'title',
  artist: 'artist',
  album: 'album',
  genre: 'genre',
  key: 'key',
  comment: 'comment'
}

function fieldToColumn(field: string): string | null {
  return COL_MAP[field] ?? null
}
