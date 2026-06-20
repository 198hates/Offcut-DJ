import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getAnthropic, AI_REASON_MODEL } from './client'
import { recordUsage, overBudget, BUDGET_ERROR } from './usage'
import { getLibraryDb, rowToTrack } from '../../library/db'
import type { Track, AiAgentEvent } from '../../../shared/types'

/**
 * Conversational AI agent over the user's own library. A manual tool-use loop
 * runs in the main process: Claude searches and inspects the library (read
 * tools) and can create a playlist from track ids it has chosen (the one write
 * tool). Writes are additive and reversible — no deletes, no edits, no exports.
 */

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_library_overview',
    description:
      'Summarise the library: total tracks, how many are fully analysed (have BPM + key), the BPM range, how many are unplayed, and the most common genres. Call this first when you need a sense of what the user has.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'search_library',
    description:
      'Find tracks matching musical criteria. All filters are optional and combine with AND. Keys are Camelot (e.g. "8A"). energy is 1–10, mood is −1…+1, rating 0–5. Returns compact track rows including their id, which you pass to create_playlist.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bpmMin: { type: 'number' },
        bpmMax: { type: 'number' },
        energyMin: { type: 'number' },
        energyMax: { type: 'number' },
        moodMin: { type: 'number' },
        moodMax: { type: 'number' },
        ratingMin: { type: 'number' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Camelot keys to include' },
        genre: { type: 'string', description: 'case-insensitive substring match on genre' },
        artist: { type: 'string', description: 'case-insensitive substring match on artist' },
        unplayed: { type: 'boolean', description: 'only tracks never played' },
        hasGrid: { type: 'boolean', description: 'only tracks with a beat grid' },
        limit: { type: 'number', description: 'max rows to return (default 40, max 80)' }
      }
    }
  },
  {
    name: 'create_playlist',
    description:
      'Create a new playlist containing the given tracks, in the given order. Use the track ids returned by search_library. Returns the new playlist id and how many tracks were added.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        trackIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['name', 'trackIds']
    }
  }
]

// ── Tool executor ─────────────────────────────────────────────────────────────

function allTracks(): Track[] {
  const db = getLibraryDb()
  return (db.prepare('SELECT * FROM tracks').all() as Record<string, unknown>[]).map(rowToTrack)
}

interface SearchInput {
  bpmMin?: number; bpmMax?: number
  energyMin?: number; energyMax?: number
  moodMin?: number; moodMax?: number
  ratingMin?: number
  keys?: string[]; genre?: string; artist?: string
  unplayed?: boolean; hasGrid?: boolean; limit?: number
}

function compact(t: Track): Record<string, unknown> {
  return {
    id: t.id, title: t.title, artist: t.artist, genre: t.genre || null,
    bpm: t.bpm, key: t.key, energy: t.energy, mood: t.mood,
    rating: t.rating, playCount: t.playCount,
    durationSecs: t.durationSeconds
  }
}

function doSearch(input: SearchInput): { count: number; returned: number; tracks: Record<string, unknown>[] } {
  const keys = input.keys?.length ? new Set(input.keys.map((k) => k.toUpperCase())) : null
  const genre = input.genre?.trim().toLowerCase() || null
  const artist = input.artist?.trim().toLowerCase() || null
  let r = allTracks()
  if (input.bpmMin != null) r = r.filter((t) => t.bpm != null && t.bpm >= input.bpmMin!)
  if (input.bpmMax != null) r = r.filter((t) => t.bpm != null && t.bpm <= input.bpmMax!)
  if (input.energyMin != null) r = r.filter((t) => t.energy != null && t.energy >= input.energyMin!)
  if (input.energyMax != null) r = r.filter((t) => t.energy != null && t.energy <= input.energyMax!)
  if (input.moodMin != null) r = r.filter((t) => t.mood != null && t.mood >= input.moodMin!)
  if (input.moodMax != null) r = r.filter((t) => t.mood != null && t.mood <= input.moodMax!)
  if (input.ratingMin != null) r = r.filter((t) => t.rating >= input.ratingMin!)
  if (keys) r = r.filter((t) => t.key && keys.has(t.key.toUpperCase()))
  if (genre) r = r.filter((t) => (t.genre || '').toLowerCase().includes(genre))
  if (artist) r = r.filter((t) => (t.artist || '').toLowerCase().includes(artist))
  if (input.unplayed) r = r.filter((t) => t.playCount === 0)
  if (input.hasGrid) r = r.filter((t) => t.beatgrid.length > 0)
  // Cap returned rows tightly: every track here is re-sent on every later turn,
  // so a 200-row result is paid for many times over. `count` still reports the
  // true total so the model knows to narrow its filter.
  const limit = Math.min(Math.max(1, input.limit ?? 40), 80)
  return { count: r.length, returned: Math.min(r.length, limit), tracks: r.slice(0, limit).map(compact) }
}

function createPlaylist(name: string, trackIds: string[]): { playlistId: string; name: string; added: number } {
  const db = getLibraryDb()
  const known = new Set((db.prepare('SELECT id FROM tracks').all() as { id: string }[]).map((x) => x.id))
  const ids = trackIds.filter((id) => known.has(id))
  const id = randomUUID()
  db.prepare(
    "INSERT INTO playlists (id, name, is_folder, sort_order, source_ids) VALUES (?, ?, 0, 0, '{}')"
  ).run(id, name || 'AI playlist')
  const stmt = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)')
  db.transaction(() => ids.forEach((tid, i) => stmt.run(id, tid, i)))()
  return { playlistId: id, name: name || 'AI playlist', added: ids.length }
}

/** Run one tool. Returns the JSON-serialisable result and a short human summary. */
function runTool(name: string, input: unknown): { result: unknown; summary: string; libraryChanged: boolean } {
  const inp = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'get_library_overview': {
      const all = allTracks()
      const analysed = all.filter((t) => t.bpm != null && t.key).length
      const unplayed = all.filter((t) => t.playCount === 0).length
      const bpms = all.map((t) => t.bpm).filter((b): b is number => b != null)
      const genreCounts = new Map<string, number>()
      for (const t of all) if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1)
      const genres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([g, c]) => ({ genre: g, count: c }))
      return {
        result: {
          total: all.length, analysed, unplayed,
          bpmRange: bpms.length ? [Math.min(...bpms), Math.max(...bpms)] : null,
          genres
        },
        summary: `${all.length} tracks · ${analysed} analysed · ${genres.length} genres`,
        libraryChanged: false
      }
    }
    case 'search_library': {
      const res = doSearch(inp as SearchInput)
      return {
        result: res,
        summary: `${res.count} match${res.count === 1 ? '' : 'es'}${res.returned < res.count ? ` (showing ${res.returned})` : ''}`,
        libraryChanged: false
      }
    }
    case 'create_playlist': {
      const nm = String(inp.name ?? 'AI playlist')
      const ids = Array.isArray(inp.trackIds) ? (inp.trackIds as unknown[]).map(String) : []
      const res = createPlaylist(nm, ids)
      return { result: res, summary: `Created "${res.name}" · ${res.added} tracks`, libraryChanged: true }
    }
    default:
      return { result: { error: `Unknown tool: ${name}` }, summary: `unknown tool ${name}`, libraryChanged: false }
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────

const AGENT_SYSTEM = `You are the assistant inside Offcut, a DJ library manager. You help the DJ explore their library and assemble playlists by reasoning and using tools.

The library is the user's own collection. Keys are Camelot (e.g. "8A"); energy is 1–10; mood is −1 (dark) … +1 (bright); BPM is the tempo.

How to work:
- Use get_library_overview when you need to understand what the user has before searching.
- Use search_library to find candidate tracks; it returns track ids.
- When asked to build/save a set or playlist, decide a sensible ORDER yourself (energy arc, harmonic mixing, smooth tempo) and call create_playlist with the ids in that order. Don't ask permission to create — the user asked.
- Make reasonable assumptions rather than stalling on clarifying questions; state the assumptions you made.
- If a request needs something you have no tool for (deleting, editing tags, exporting to USB), say so plainly and suggest the page that does it.

Keep replies concise. After acting, briefly tell the user what you did and name the playlist you created. Never invent track ids — only use ids returned by search_library.`

// Each turn re-sends the whole transcript, so cost grows quadratically with the
// turn count. 5 is enough for a search-filter-build flow; the cap stops a
// confused loop from quietly running up a bill.
const MAX_TURNS = 5

/**
 * Run the agent for one user message, emitting events as it goes. Resolves when
 * the turn is complete. The whole loop runs in the main process.
 */
export async function runAgent(
  query: string,
  history: Anthropic.MessageParam[],
  runId: number,
  emit: (e: AiAgentEvent) => void
): Promise<void> {
  const client = getAnthropic()
  if (!client) { emit({ type: 'error', runId, message: 'AI is off or no API key is set (Settings → AI).' }); return }
  if (!query.trim()) { emit({ type: 'error', runId, message: 'Empty request.' }); return }
  if (overBudget()) { emit({ type: 'error', runId, message: BUDGET_ERROR }); return }

  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: query }]

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await client.messages.create({
        // Sonnet + low effort: the agent re-sends a growing transcript every
        // turn, so the per-token rate and the turn count dominate cost. Opus
        // here was the main credit sink.
        model: AI_REASON_MODEL,
        max_tokens: 2048,
        output_config: { effort: 'low' },
        system: AGENT_SYSTEM,
        tools: TOOLS,
        messages
      })
      recordUsage(AI_REASON_MODEL, res.usage)

      for (const block of res.content) {
        if (block.type === 'text' && block.text.trim()) emit({ type: 'text', runId, text: block.text })
      }

      if (res.stop_reason !== 'tool_use') { emit({ type: 'done', runId }); return }

      messages.push({ role: 'assistant', content: res.content })
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue
        emit({ type: 'tool', runId, tool: block.name, summary: describeCall(block.name, block.input) })
        let out: { result: unknown; summary: string; libraryChanged: boolean }
        try {
          out = runTool(block.name, block.input)
        } catch (err) {
          out = { result: { error: (err as Error).message }, summary: (err as Error).message, libraryChanged: false }
        }
        emit({ type: 'tool_result', runId, tool: block.name, summary: out.summary, ok: !('error' in (out.result as object)) })
        if (out.libraryChanged) emit({ type: 'library_changed', runId })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out.result) })
      }
      messages.push({ role: 'user', content: toolResults })
    }
    emit({ type: 'text', runId, text: '(Stopped after reaching the step limit.)' })
    emit({ type: 'done', runId })
  } catch (err) {
    emit({ type: 'error', runId, message: (err as Error).message })
  }
}

/** A short human label for a tool call, shown in the transcript. */
function describeCall(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>
  if (name === 'get_library_overview') return 'Reading library overview'
  if (name === 'search_library') {
    const bits: string[] = []
    if (inp.genre) bits.push(String(inp.genre))
    if (inp.artist) bits.push(`artist ~ ${inp.artist}`)
    if (inp.bpmMin != null || inp.bpmMax != null) bits.push(`${inp.bpmMin ?? ''}–${inp.bpmMax ?? ''} bpm`)
    if (inp.energyMin != null || inp.energyMax != null) bits.push(`energy ${inp.energyMin ?? ''}–${inp.energyMax ?? ''}`)
    if (Array.isArray(inp.keys) && inp.keys.length) bits.push(`keys ${(inp.keys as string[]).join(',')}`)
    if (inp.unplayed) bits.push('unplayed')
    return `Searching${bits.length ? ' — ' + bits.join(', ') : ''}`
  }
  if (name === 'create_playlist') {
    const n = Array.isArray(inp.trackIds) ? (inp.trackIds as unknown[]).length : 0
    return `Creating playlist "${inp.name ?? ''}" (${n} tracks)`
  }
  return name
}
