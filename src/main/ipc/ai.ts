import { ipcMain } from 'electron'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { getAnthropic, AI_MODEL, AI_CHEAP_MODEL } from '../integrations/ai/client'
import { runAgent } from '../integrations/ai/agent'
import { getSettings } from '../settings'
import type {
  AiSearchFilter, AiSeqTrack, AiSequenceResult, AiTidyTrack, AiTidyResult,
  AiDigResult, AiDigSuggestion, AiDigSource
} from '../../shared/types'

// JSON-schema for structured output. Every field is required (strict mode);
// numeric dimensions are nullable so "unconstrained" is explicit.
const num = { type: ['number', 'null'] } as const
const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bpmMin: num, bpmMax: num,
    energyMin: num, energyMax: num,
    danceMin: num, danceMax: num,
    moodMin: num, moodMax: num,
    ratingMin: num, ratingMax: num,
    keys: { type: 'array', items: { type: 'string' } },
    genres: { type: 'array', items: { type: 'string' } },
    hasCues: { type: 'boolean' },
    hasGrid: { type: 'boolean' },
    unplayed: { type: 'boolean' },
    sortBy: { type: 'string', enum: ['title', 'bpm', 'energy', 'rating'] },
    explanation: { type: 'string' }
  },
  required: [
    'bpmMin', 'bpmMax', 'energyMin', 'energyMax', 'danceMin', 'danceMax',
    'moodMin', 'moodMax', 'ratingMin', 'ratingMax', 'keys', 'genres',
    'hasCues', 'hasGrid', 'unplayed', 'sortBy', 'explanation'
  ]
} as const

const SEARCH_SYSTEM = `You translate a DJ's natural-language track search into a structured filter over their library.

Use null for any dimension the query does not constrain:
- bpmMin/bpmMax: tempo in BPM (~60–200).
- energyMin/energyMax: perceived intensity, 1 (calm) … 10 (peak).
- danceMin/danceMax: danceability, 0 … 1.
- moodMin/moodMax: valence, -1 (dark/tense) … +1 (bright/euphoric).
- ratingMin/ratingMax: star rating, 0 … 5.
- keys: array of Camelot keys (e.g. "8A","5B") — ONLY values from the provided available-keys list; [] if none.
- genres: array — ONLY values from the provided available-genres list; [] if none. Match loosely (e.g. "deep house" matches any provided genre containing it).
- hasCues / hasGrid: true only when the user explicitly wants tracks that already have cue points / a beat grid.
- unplayed: true only when the user wants tracks they haven't played.
- sortBy: one of title|bpm|energy|rating that best fits the request, else "title".
- explanation: one short sentence on how you read the query.

Interpret intent: "peak time" → high energy (~8–10); "warm-up" → lower energy (~2–5); "uplifting/euphoric" → high mood; "dark/moody" → low mood. Only set a field when the query implies it.`

// ── Set sequencing ────────────────────────────────────────────────────────────

const SEQ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trackId: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['trackId', 'reason']
      }
    },
    arc: { type: 'string' }
  },
  required: ['order', 'arc']
} as const

const SEQ_SYSTEM = `You are a veteran DJ sequencing a set from a fixed pool of tracks.

You will get a JSON list of tracks (id, title, artist, genre, bpm, key in Camelot, energy 1–10, mood −1…+1, duration). Order EVERY track into a set that tells a coherent story.

Principles:
- Energy arc: open lower, build, hold a peak, and resolve — unless the intent says otherwise. Avoid yo-yoing energy.
- Harmonic mixing: prefer adjacent Camelot moves (same number, ±1 number, or relative major/minor). A bold key jump is fine occasionally for effect — call it out in the reason.
- Tempo: keep BPM changes gradual; large jumps belong at deliberate reset points.
- Mood: let valence drift smoothly rather than lurching.
- Use every track exactly once. Do not invent track ids — use only the ids given.

Return the full ordering. Each step's "reason" is one short clause on why that track follows the previous one (harmonic move, energy step, mood shift). The "arc" is one paragraph describing the set's overall shape.`

// ── Metadata tidy ─────────────────────────────────────────────────────────────

const TIDY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trackId: { type: 'string' },
          title: { type: 'string' },
          artist: { type: 'string' },
          genre: { type: 'string' }
        },
        required: ['trackId', 'title', 'artist', 'genre']
      }
    }
  },
  required: ['results']
} as const

const TIDY_SYSTEM = `You clean messy DJ track metadata. For each input track you receive id, title, artist, album, genre.

Return, for EVERY track, the corrected title, artist and genre:
- title: fix casing (Title Case), expand/strip nothing musical. Remove promo junk ("free download", "out now", URLs, store tags) and stray numbering. KEEP remixer/version credits that belong in the title, e.g. "(Someone Remix)", "(Extended Mix)".
- artist: canonical spelling/casing of the primary artist(s). Keep stylised names as the scene writes them (e.g. "deadmau5", "ZHU"). Do not move featured artists around unless the title clearly belongs there.
- genre: a single common DJ genre (e.g. "House", "Tech House", "Drum & Bass", "Techno", "Trance", "Disco"). If the existing genre is already reasonable, echo it. If you genuinely cannot tell, return the existing genre, or "" if there was none.

Echo each track's id as trackId. Only correct what is clearly wrong — when a field is already clean, return it unchanged. Never invent artists or titles.`

// ── Crate-dig context (web search) ────────────────────────────────────────────

const DIG_SYSTEM = `You are a crate-digging research assistant for a DJ. Given a seed record (artist + title, or just an artist), use web search to research it, then help the DJ find adjacent music worth digging into.

Cover, where the sources support it: the scene / era / label / sound of the record, and a handful of SPECIFIC artists or tracks to dig into next (related producers, the label's roster, key remixes, sampled/sampling records, contemporaries). Ground every claim in what you actually find — do not pad with generic genre lore, and never invent releases.

End your reply with a single fenced \`\`\`json code block, and nothing after it, of the exact shape:
{"summary": "<3-5 sentences>", "suggestions": [{"artist": "<name>", "title": "<track or release, or empty string for an artist-level lead>", "why": "<one clause>"}]}
Aim for 5-8 suggestions. Keep prose before the block short — the JSON is what the app reads.`

interface DigJson { summary?: string; suggestions?: AiDigSuggestion[] }

/** Pull the trailing JSON object out of the model's reply, tolerating fences/prose. */
function extractDigJson(text: string): DigJson | null {
  const candidates: string[] = []
  const fences = text.match(/```(?:json)?\s*([\s\S]*?)```/gi)
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/i, '').replace(/```\s*$/, ''))
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a !== -1 && b > a) candidates.push(text.slice(a, b + 1))
  for (const c of candidates.reverse()) {
    try {
      const o = JSON.parse(c.trim())
      if (o && typeof o === 'object') return o as DigJson
    } catch { /* try the next candidate */ }
  }
  return null
}

export function registerAiHandlers(): void {
  ipcMain.handle('ai:status', () => {
    const s = getSettings()
    return { enabled: !!s.aiEnabled, hasKey: !!s.anthropicApiKey }
  })

  ipcMain.handle(
    'ai:nlSearch',
    async (
      _e,
      query: string,
      facets: { genres: string[]; keys: string[] }
    ): Promise<{ filter?: AiSearchFilter; error?: string }> => {
      const client = getAnthropic()
      if (!client) return { error: 'AI is off or no API key is set (Settings → AI).' }
      if (!query.trim()) return { error: 'Empty search.' }
      try {
        const msg = await client.messages.parse({
          model: AI_MODEL,
          max_tokens: 1024,
          output_config: { effort: 'low', format: jsonSchemaOutputFormat(FILTER_SCHEMA) },
          system: SEARCH_SYSTEM,
          messages: [
            {
              role: 'user',
              content:
                `Available genres: ${facets.genres.join(', ') || '(none)'}\n` +
                `Available keys (Camelot): ${facets.keys.join(', ') || '(none)'}\n\n` +
                `Query: ${query.trim()}`
            }
          ]
        })
        const filter = msg.parsed_output as AiSearchFilter | null
        if (!filter) return { error: "Couldn't interpret that search." }
        return { filter }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'ai:sequenceSet',
    async (
      _e,
      tracks: AiSeqTrack[],
      intent?: string
    ): Promise<{ result?: AiSequenceResult; error?: string }> => {
      const client = getAnthropic()
      if (!client) return { error: 'AI is off or no API key is set (Settings → AI).' }
      if (!tracks?.length) return { error: 'No tracks to sequence.' }
      if (tracks.length < 2) return { error: 'Need at least 2 tracks to sequence.' }
      try {
        const intentLine = intent?.trim() ? `Intent: ${intent.trim()}\n\n` : ''
        const msg = await client.messages.parse({
          model: AI_MODEL,
          max_tokens: 8192,
          thinking: { type: 'adaptive' },
          output_config: { format: jsonSchemaOutputFormat(SEQ_SCHEMA) },
          system: SEQ_SYSTEM,
          messages: [
            { role: 'user', content: intentLine + `Tracks:\n${JSON.stringify(tracks)}` }
          ]
        })
        const raw = msg.parsed_output as AiSequenceResult | null
        if (!raw) return { error: "Couldn't sequence that set." }

        // Reconcile against the input: keep only known ids, drop dupes, and
        // append any tracks the model omitted so the chapter never loses a track.
        const known = new Map(tracks.map((t) => [t.id, t]))
        const seen = new Set<string>()
        const order = raw.order.filter((s) => {
          if (!known.has(s.trackId) || seen.has(s.trackId)) return false
          seen.add(s.trackId)
          return true
        })
        for (const t of tracks) {
          if (!seen.has(t.id)) order.push({ trackId: t.id, reason: '(appended — not placed by AI)' })
        }
        return { result: { order, arc: raw.arc } }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'ai:tidyMetadata',
    async (
      _e,
      tracks: AiTidyTrack[]
    ): Promise<{ results?: AiTidyResult[]; error?: string }> => {
      const client = getAnthropic()
      if (!client) return { error: 'AI is off or no API key is set (Settings → AI).' }
      if (!tracks?.length) return { error: 'No tracks to tidy.' }
      try {
        const known = new Set(tracks.map((t) => t.id))
        const msg = await client.messages.parse({
          model: AI_CHEAP_MODEL,
          max_tokens: 8192,
          output_config: { format: jsonSchemaOutputFormat(TIDY_SCHEMA) },
          system: TIDY_SYSTEM,
          messages: [{ role: 'user', content: `Tracks:\n${JSON.stringify(tracks)}` }]
        })
        const raw = msg.parsed_output as { results: AiTidyResult[] } | null
        if (!raw) return { error: "Couldn't tidy that metadata." }
        // Keep only results that map back to a real input id.
        const results = raw.results.filter((r) => known.has(r.trackId))
        return { results }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'ai:digContext',
    async (
      _e,
      seed: { artist: string; title: string }
    ): Promise<{ result?: AiDigResult; error?: string }> => {
      const client = getAnthropic()
      if (!client) return { error: 'AI is off or no API key is set (Settings → AI).' }
      const artist = (seed?.artist || '').trim()
      const title = (seed?.title || '').trim()
      if (!artist && !title) return { error: 'Nothing to research.' }
      try {
        const who = title
          ? `the record "${title}"${artist ? ` by ${artist}` : ''}`
          : `the artist ${artist}`
        const msg = await client.messages.create({
          model: AI_MODEL,
          max_tokens: 4096,
          system: DIG_SYSTEM,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
          messages: [{ role: 'user', content: `Research ${who} for crate-digging.` }]
        })

        // Concatenate the model's prose and harvest web-search citations.
        let text = ''
        const sources: AiDigSource[] = []
        const seenUrls = new Set<string>()
        for (const block of msg.content) {
          if (block.type !== 'text') continue
          text += block.text
          for (const cit of block.citations ?? []) {
            const url = (cit as { url?: string }).url
            if (!url || seenUrls.has(url)) continue
            seenUrls.add(url)
            sources.push({ title: (cit as { title?: string | null }).title || url, url })
          }
        }

        const parsed = extractDigJson(text)
        const summary = (parsed?.summary || '').trim() || text.replace(/```[\s\S]*?```/g, '').trim()
        const suggestions: AiDigSuggestion[] = Array.isArray(parsed?.suggestions)
          ? parsed!.suggestions
              .map((s) => ({
                artist: String(s?.artist ?? '').trim(),
                title: String(s?.title ?? '').trim(),
                why: String(s?.why ?? '').trim()
              }))
              .filter((s) => s.artist || s.title)
          : []
        if (!summary && !suggestions.length) return { error: "Couldn't research that seed." }
        return { result: { summary, suggestions, sources } }
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
  )

  // Conversational agent — streams events back over 'ai:agentEvent'; resolves
  // when the turn is complete. `history` is the prior turns as plain text.
  ipcMain.handle(
    'ai:agentRun',
    async (
      e,
      query: string,
      history: { role: 'user' | 'assistant'; content: string }[],
      runId: number
    ): Promise<boolean> => {
      await runAgent(query, history ?? [], runId, (evt) => {
        if (!e.sender.isDestroyed()) e.sender.send('ai:agentEvent', evt)
      })
      return true
    }
  )
}
