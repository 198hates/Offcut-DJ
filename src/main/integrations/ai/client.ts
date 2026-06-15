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

/** Default model for AI reasoning features. */
export const AI_MODEL = 'claude-opus-4-8'
