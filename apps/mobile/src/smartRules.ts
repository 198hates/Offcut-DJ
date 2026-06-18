// Client-side smart-playlist evaluation — an in-memory port of the desktop's
// SQL evaluator (src/main/library/smart-playlist.ts), so a smartlist resolves
// identically on the phone over the mirrored library (the desktop resolves them
// dynamically and ships no membership, so without this they'd appear empty).
//
// Rules are AND-combined. Semantics mirror the SQL: strings are case-insensitive
// (is/contains), tags = exact array membership, customTag = per-key on
// customTags, numerics use >/</between, dates use in_last_days. As in SQL, a
// null/absent field fails every comparison (NULL is never true).

import type { Playlist, SmartRule, SmartRuleField, Track } from './sync-types'

const STRING_FIELDS = new Set<SmartRuleField>(['title', 'artist', 'album', 'genre', 'label', 'key', 'comment'])
const NUMERIC_FIELDS = new Set<SmartRuleField>(['bpm', 'rating', 'year', 'durationSeconds', 'playCount', 'energy', 'danceability', 'mood'])
const DATE_FIELDS = new Set<SmartRuleField>(['dateAdded', 'lastPlayedAt'])

function trackValue(t: Track, field: SmartRuleField): unknown {
  return (t as unknown as Record<string, unknown>)[field]
}

function matchesRule(t: Track, rule: SmartRule): boolean {
  const { field, op } = rule

  if (field === 'customTag') {
    const key = rule.customTagKey?.trim()
    if (!key) return true // no key → no constraint (mirrors SQL `continue`)
    const cur = t.customTags?.[key]
    const val = String(rule.value)
    switch (op) {
      case 'is': return cur === val
      case 'is_not': return cur == null || cur !== val
      case 'contains': return cur != null && cur.toLowerCase().includes(val.toLowerCase())
      case 'not_contains': return cur == null || !cur.toLowerCase().includes(val.toLowerCase())
      default: return true
    }
  }

  if (field === 'tags') {
    const val = String(rule.value).toLowerCase()
    const has = (t.tags ?? []).some((x) => x.toLowerCase() === val)
    if (op === 'contains' || op === 'is') return has
    if (op === 'not_contains' || op === 'is_not') return !has
    return true
  }

  const raw = trackValue(t, field)

  if (DATE_FIELDS.has(field)) {
    if (op !== 'in_last_days') return true
    if (raw == null) return false
    const ms = Date.parse(String(raw).replace(' ', 'T'))
    if (Number.isNaN(ms)) return false
    return ms >= Date.now() - Number(rule.value) * 86_400_000
  }

  if (NUMERIC_FIELDS.has(field)) {
    if (raw == null) return false // NULL fails every comparison, as in SQL
    const n = Number(raw)
    switch (op) {
      case 'is': return n === Number(rule.value)
      case 'is_not': return n !== Number(rule.value)
      case 'greater_than': return n > Number(rule.value)
      case 'less_than': return n < Number(rule.value)
      case 'between': {
        const [lo, hi] = rule.value as [number, number]
        return n >= lo && n <= hi
      }
      case 'contains': return String(n).includes(String(rule.value))
      case 'not_contains': return !String(n).includes(String(rule.value))
      default: return true
    }
  }

  if (STRING_FIELDS.has(field)) {
    if (raw == null) return false
    const s = String(raw).toLowerCase()
    const val = String(rule.value).toLowerCase()
    switch (op) {
      case 'is': return s === val
      case 'is_not': return s !== val
      case 'contains': return s.includes(val)
      case 'not_contains': return !s.includes(val)
      default: return true
    }
  }

  return true
}

/** AND-combine all rules. Empty rules ⇒ matches everything (mirrors SQL). */
export function matchesAllRules(t: Track, rules: SmartRule[]): boolean {
  return rules.every((r) => matchesRule(t, r))
}

/** The effective track list for a playlist: evaluated rules for smartlists,
 *  ordered membership otherwise. */
export function playlistTracks(p: Playlist, all: Track[], byId: Map<string, Track>): Track[] {
  if (p.isSmart) {
    return all
      .filter((t) => matchesAllRules(t, p.rules ?? []))
      .sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`))
  }
  return p.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
}
