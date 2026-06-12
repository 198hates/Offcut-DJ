/**
 * usePreview — thin wrapper over the shared `trackPreviewStore`.
 *
 * Both the old hook and the store decoded + played a 30s clip independently;
 * this now delegates to the single store engine so there's one preview at a
 * time across the whole app (Library, Orders, Set Builder, LibraryMini).
 */

import { useCallback } from 'react'
import type { Track } from '@shared/types'
import { useTrackPreview } from '../store/trackPreviewStore'

export function usePreview(): {
  previewId: string | null
  preview: (track: Track, durationSec?: number) => Promise<void>
  toggle: (track: Track, durationSec?: number) => Promise<void>
  stop: () => void
} {
  const previewId = useTrackPreview((s) => s.previewId)
  const toggle = useTrackPreview((s) => s.toggle)
  const stop = useTrackPreview((s) => s.stop)

  // preview() = ensure this track is playing (start if not already current).
  const preview = useCallback(async (track: Track, durationSec?: number) => {
    if (useTrackPreview.getState().previewId !== track.id) {
      await useTrackPreview.getState().toggle(track, durationSec)
    }
  }, [])

  return { previewId, preview, toggle, stop }
}
