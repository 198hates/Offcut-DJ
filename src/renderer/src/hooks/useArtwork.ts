import { useState, useEffect } from 'react'

// Module-level LRU cache — persists for the session, zero re-fetch cost for
// the same file path after the first load.  Capped at 200 entries to avoid
// unbounded memory growth from large base64 strings.
const MAX_CACHE = 200
const cache     = new Map<string, string | null>()

function evictIfNeeded() {
  if (cache.size >= MAX_CACHE) {
    // Evict the oldest entry (Map preserves insertion order)
    cache.delete(cache.keys().next().value!)
  }
}

/**
 * Returns the embedded album artwork for an audio file as a base64 data URL,
 * or null if none is found / the file has no cover art.
 *
 * Results are cached for the session — the IPC call fires at most once per
 * unique filePath.
 */
export function useArtwork(filePath: string | null | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    if (!filePath) return null
    return cache.has(filePath) ? (cache.get(filePath) ?? null) : null
  })

  useEffect(() => {
    if (!filePath) { setDataUrl(null); return }
    if (cache.has(filePath)) {
      setDataUrl(cache.get(filePath) ?? null)
      return
    }
    let cancelled = false
    window.api.audio.readArtwork(filePath).then((url) => {
      evictIfNeeded()
      cache.set(filePath, url)
      if (!cancelled) setDataUrl(url)
    }).catch(() => {
      cache.set(filePath, null)
    })
    return () => { cancelled = true }
  }, [filePath])

  return dataUrl
}
