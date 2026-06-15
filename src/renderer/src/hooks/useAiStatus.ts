import { useState, useEffect } from 'react'

/** Custom event Settings dispatches after saving so AI-gated UI refreshes at once. */
export const AI_SETTINGS_CHANGED = 'ai-settings-changed'

/**
 * Returns whether AI features are usable (enabled in Settings *and* a key is set).
 * Re-checks on mount, on window focus, and whenever Settings saves — so toggling
 * AI on makes the AI affordances appear without navigating away and back.
 */
export function useAiStatus(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    const check = (): void => {
      window.api.ai
        .status()
        .then((s) => { if (alive) setReady(s.enabled && s.hasKey) })
        .catch(() => { if (alive) setReady(false) })
    }
    check()
    window.addEventListener('focus', check)
    window.addEventListener(AI_SETTINGS_CHANGED, check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
      window.removeEventListener(AI_SETTINGS_CHANGED, check)
    }
  }, [])

  return ready
}
