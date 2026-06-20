// Estimated AI spend tracking + a soft monthly budget guard.
//
// Anthropic doesn't bill us back through the API, so we ESTIMATE cost from the
// token usage every response reports (input/output/cache) times the published
// per-model rate, plus the web-search tool fee. The running total is persisted
// in settings so it survives restarts, rolls over each month, and can gate AI
// calls once a user-set cap is hit. Estimates only — treat as a guide, and set
// a real hard cap in the Anthropic Console for the actual backstop.

import { getSettings, saveSettings } from '../../settings'
import type { AiUsage } from '../../../shared/types'

interface Rate {
  in: number
  out: number
}
// USD per 1M tokens (input / output). Falls back to Haiku rates for unknowns.
const RATES: Record<string, Rate> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }
}
const CACHE_READ_MULT = 0.1 // cache reads ≈ 10% of input
const CACHE_WRITE_MULT = 1.25 // 5-minute cache writes ≈ 125% of input
const WEB_SEARCH_PER_REQUEST = 0.01 // $10 / 1,000 searches

/** The subset of Anthropic's `usage` object we price from (all optional). */
export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

/** Estimated USD cost of one response, from its token usage. */
export function costOf(model: string, u: UsageLike | null | undefined): number {
  if (!u) return 0
  const r = RATES[model] ?? RATES['claude-haiku-4-5']
  const inTok = u.input_tokens ?? 0
  const outTok = u.output_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const web = u.server_tool_use?.web_search_requests ?? 0
  const tokenUsd =
    (inTok * r.in + outTok * r.out + cacheRead * r.in * CACHE_READ_MULT + cacheWrite * r.in * CACHE_WRITE_MULT) /
    1_000_000
  return tokenUsd + web * WEB_SEARCH_PER_REQUEST
}

function monthKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Current usage figures, with the monthly bucket rolled over if the month changed. */
export function getUsage(): AiUsage {
  const u = getSettings().aiUsage
  const mk = monthKey()
  if (!u) return { monthKey: mk, monthUsd: 0, totalUsd: 0, calls: 0, lastUsd: 0, lastModel: '' }
  if (u.monthKey !== mk) return { ...u, monthKey: mk, monthUsd: 0 }
  return u
}

/** Add one call's estimated cost to the running totals; returns the new state. */
export function recordUsage(model: string, usage: UsageLike | null | undefined): AiUsage {
  const cost = costOf(model, usage)
  const cur = getUsage()
  const next: AiUsage = {
    monthKey: cur.monthKey,
    monthUsd: cur.monthUsd + cost,
    totalUsd: cur.totalUsd + cost,
    calls: cur.calls + 1,
    lastUsd: cost,
    lastModel: model
  }
  saveSettings({ aiUsage: next })
  return next
}

/** True when a positive monthly cap is set and this month's estimate has reached it. */
export function overBudget(): boolean {
  const cap = getSettings().aiMonthlyBudgetUsd
  if (cap == null || cap <= 0) return false
  return getUsage().monthUsd >= cap
}

/** Standard error returned by handlers when the cap is hit. */
export const BUDGET_ERROR =
  'Monthly AI budget reached (Settings → AI). Raise or clear the cap to keep using AI features.'

/** Zero the counters (keeps the cap). */
export function resetUsage(): AiUsage {
  const fresh: AiUsage = { monthKey: monthKey(), monthUsd: 0, totalUsd: 0, calls: 0, lastUsd: 0, lastModel: '' }
  saveSettings({ aiUsage: fresh })
  return fresh
}
