// Serialises calls to an API so we stay under its rate limit.
// Discogs (authenticated) allows ~60/min; MusicBrainz wants <= 1/sec.
// 1100ms between requests keeps us comfortably under both.

export class RateLimiter {
  private minIntervalMs: number
  private queue: Promise<unknown>
  private lastRun: number

  constructor(minIntervalMs = 1100) {
    this.minIntervalMs = minIntervalMs
    this.queue = Promise.resolve()
    this.lastRun = 0
  }

  // Runs fn one-at-a-time, spacing each start by at least minIntervalMs.
  // A rejecting call does not break the queue for later calls.
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRun)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.lastRun = Date.now()
      return fn()
    })
    this.queue = run.catch(() => {}) // keep the chain alive
    return run
  }
}
