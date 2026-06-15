import { ipcMain } from 'electron'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { getAnthropic, AI_MODEL } from '../integrations/ai/client'
import { getSettings } from '../settings'
import type { AiSearchFilter } from '../../shared/types'

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
}
