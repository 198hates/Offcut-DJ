/**
 * mapPool — run an async worker over items with bounded concurrency.
 *
 * Used by the batch analysis tools so several tracks decode/analyse at once
 * (decoding shells out to ffmpeg in the main process, so concurrency overlaps
 * those native decodes across cores instead of running them one at a time).
 * Errors per item are swallowed (the pass skips bad files); progress is
 * reported by completion count, and a `cancelled` predicate stops new work.
 */
export async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  opts?: { onProgress?: (done: number, total: number) => void; cancelled?: () => boolean }
): Promise<void> {
  const total = items.length
  let next = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts?.cancelled?.()) return
      const i = next++
      if (i >= total) return
      try {
        await fn(items[i], i)
      } catch {
        /* skip unreadable / failed item */
      }
      done++
      opts?.onProgress?.(done, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), total) }, worker))
}

/**
 * Recommended analysis concurrency for a machine. Scales with cores but is
 * pulled back on low-RAM systems (each in-flight track holds a decoded buffer).
 */
export function suggestConcurrency(cpuCount: number, totalMemGB: number): number {
  let c = Math.max(2, Math.min(8, cpuCount - 2))
  if (totalMemGB && totalMemGB <= 8) c = Math.min(c, 3)
  if (totalMemGB && totalMemGB <= 4) c = 2
  return c
}

/** Resolve a user setting (0/undefined = auto) to a concrete concurrency. */
export function resolveConcurrency(setting: number | undefined): number {
  if (setting && setting > 0) return Math.min(16, setting)
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  return suggestConcurrency(cores, 0)
}
