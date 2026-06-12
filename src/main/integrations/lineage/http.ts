// Resilient JSON fetch for the Lineage API clients.
//
// Every external call (Discogs, Last.fm, MusicBrainz) goes through here so a
// transient 429 / 5xx / network blip retries with exponential backoff instead
// of failing the whole dig. Per-host *spacing* is still owned by each client's
// RateLimiter; this only adds retry on top of a call the limiter has scheduled.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface HttpOptions {
  headers?: Record<string, string>
  /** Retry attempts after the first try (default 3). */
  retries?: number
  /** Base backoff in ms; doubles each attempt, with jitter (default 700). */
  baseBackoffMs?: number
  /** Prefix for thrown error messages, e.g. "Discogs /releases/123". */
  label?: string
}

function backoff(attempt: number, base: number): number {
  // Exponential with ±25% jitter so concurrent callers don't resync.
  const exp = base * 2 ** attempt
  const jitter = exp * (0.75 + ((attempt * 7919) % 100) / 200) // deterministic-ish, no Math.random dependency
  return Math.min(jitter, 15000)
}

/** Fetch a URL as text, retrying transient failures. Throws on final failure. */
export async function httpText(url: string | URL, opts: HttpOptions = {}): Promise<string> {
  const { headers, retries = 3, baseBackoffMs = 700, label = 'request' } = opts
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers })
    } catch (netErr) {
      if (attempt >= retries) throw netErr
      await sleep(backoff(attempt, baseBackoffMs))
      continue
    }
    if (res.ok) return res.text()

    const retryable = res.status === 429 || res.status >= 500
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(attempt, baseBackoffMs)
      await sleep(wait)
      continue
    }
    throw new Error(`${label} -> ${res.status}`)
  }
}

/** Fetch a URL as parsed JSON, retrying transient failures. */
export async function httpJson<T>(url: string | URL, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(await httpText(url, opts)) as T
}
