import Anthropic from '@anthropic-ai/sdk'
import { getSettings } from '../../settings'

/**
 * Lazily-built Anthropic client, keyed on the user's API key from Settings.
 * Lives only in the main process — the key never reaches the renderer. Returns
 * null when AI is disabled or no key is set, so callers can fail gracefully.
 *
 * Privacy: AI features send only track *metadata* (titles, BPM, key, energy…),
 * never audio.
 */
let _client: Anthropic | null = null
let _key = ''

export function getAnthropic(): Anthropic | null {
  const s = getSettings()
  if (!s.aiEnabled || !s.anthropicApiKey) return null
  if (!_client || _key !== s.anthropicApiKey) {
    _client = new Anthropic({ apiKey: s.anthropicApiKey })
    _key = s.anthropicApiKey
  }
  return _client
}

/** Top-tier model. Kept available, but no feature defaults to it any more —
 *  Opus + web-search / agent loops were burning credits far faster than the
 *  task warranted. Reserve for anything a user explicitly opts into. */
export const AI_MODEL = 'claude-opus-4-8'

/** Mid-tier: strong reasoning + tool use at ~40% of Opus's per-token cost.
 *  The default for the agent and set-sequencing — Haiku isn't reliable enough
 *  at multi-step tool orchestration, and a failed cheap loop costs MORE. */
export const AI_REASON_MODEL = 'claude-sonnet-4-6'

/** Cheap model for high-volume / low-reasoning work (metadata tidy, NL search
 *  → filter, web-grounded dig summarisation). Note: the `effort` param is NOT
 *  supported on Haiku — omit it on these calls. */
export const AI_CHEAP_MODEL = 'claude-haiku-4-5'
