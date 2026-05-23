/**
 * usePreview — lightweight 30-second track preview
 *
 * Uses Web Audio API to decode and play a short clip starting from the
 * track's "Mix In" hot cue (or the beginning if none). Only one preview
 * plays at a time — calling preview() cancels any running preview.
 */

import { useState, useCallback, useRef } from 'react'
import type { Track } from '@shared/types'

const PREVIEW_DURATION = 30  // seconds

let _globalStop: (() => void) | null = null

export function usePreview() {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)

  const stop = useCallback(() => {
    if (ctxRef.current) {
      try { ctxRef.current.close() } catch { /* ignore */ }
      ctxRef.current = null
    }
    setPreviewId(null)
    _globalStop = null
  }, [])

  const preview = useCallback(async (track: Track, durationSec = PREVIEW_DURATION) => {
    // Stop any existing preview (globally — so two usePreview hooks don't fight)
    if (_globalStop) _globalStop()

    setPreviewId(track.id)
    _globalStop = stop

    try {
      const ab = await window.api.audio.readFile(track.filePath)
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const buf = await ctx.decodeAudioData(ab)

      // Find start offset: prefer 'mix-in' / 'MIX IN' cue, else beginning
      const mixInCue = track.cuePoints.find((c) =>
        c.type === 'hotcue' && /mix.?in/i.test(c.label)
      )
      const startSec = mixInCue ? mixInCue.positionMs / 1000 : 0

      const source = ctx.createBufferSource()
      source.buffer = buf
      source.connect(ctx.destination)
      source.start(0, startSec, durationSec)
      source.onended = () => {
        if (ctxRef.current === ctx) stop()
      }
    } catch {
      stop()
    }
  }, [stop])

  const toggle = useCallback(async (track: Track, durationSec = PREVIEW_DURATION) => {
    if (previewId === track.id) {
      stop()
    } else {
      await preview(track, durationSec)
    }
  }, [previewId, preview, stop])

  return { previewId, preview, toggle, stop }
}
