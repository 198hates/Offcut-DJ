/**
 * trackPreviewStore — shared 30s preview engine for library rows.
 *
 * Decodes the file once via Web Audio, computes an overview-peaks array for the
 * previewed window, plays the clip (from the Mix-In cue if present), and tracks
 * playback progress. Exposed via zustand so row play-buttons can subscribe to
 * `previewId` only (no per-frame re-render) while the waveform bar subscribes to
 * `progress`/`peaks`.
 */

import { create } from 'zustand'
import type { Track } from '@shared/types'

const PREVIEW_SECONDS = 30
const BARS = 480

let ctx: AudioContext | null = null
let raf = 0
let startedAt = 0

interface TrackPreviewState {
  previewId: string | null
  peaks: Float32Array | null
  /** 0..1 across the previewed window. */
  progress: number
  durationSec: number
  toggle: (track: Track, durationSec?: number) => Promise<void>
  stop: () => void
}

export const useTrackPreview = create<TrackPreviewState>((set, get) => ({
  previewId: null,
  peaks: null,
  progress: 0,
  durationSec: 0,

  stop: () => {
    cancelAnimationFrame(raf)
    if (ctx) {
      try {
        ctx.close()
      } catch {
        /* ignore */
      }
      ctx = null
    }
    set({ previewId: null, peaks: null, progress: 0, durationSec: 0 })
  },

  toggle: async (track: Track, durationSec = PREVIEW_SECONDS) => {
    if (get().previewId === track.id) {
      get().stop()
      return
    }
    get().stop()
    set({ previewId: track.id, peaks: null, progress: 0, durationSec: 0 })

    try {
      const ab = await window.api.audio.readFile(track.filePath)
      const c = new AudioContext()
      ctx = c
      const buf = await c.decodeAudioData(ab)
      // Bail if a different preview was started while we were decoding.
      if (get().previewId !== track.id || ctx !== c) {
        try {
          c.close()
        } catch {
          /* ignore */
        }
        return
      }

      const mixIn = track.cuePoints.find(
        (cue) => cue.type === 'hotcue' && /mix.?in/i.test(cue.label)
      )
      const startSec = mixIn ? mixIn.positionMs / 1000 : 0
      const dur = Math.min(durationSec, Math.max(1, buf.duration - startSec))

      // Overview peaks across the previewed window.
      const data = buf.getChannelData(0)
      const sr = buf.sampleRate
      const s0 = Math.floor(startSec * sr)
      const s1 = Math.min(data.length, Math.floor((startSec + dur) * sr))
      const block = Math.max(1, Math.floor((s1 - s0) / BARS))
      const peaks = new Float32Array(BARS)
      for (let i = 0; i < BARS; i++) {
        const a = s0 + i * block
        const b = Math.min(s1, a + block)
        let m = 0
        for (let j = a; j < b; j++) {
          const v = Math.abs(data[j])
          if (v > m) m = v
        }
        peaks[i] = m
      }

      const src = c.createBufferSource()
      src.buffer = buf
      src.connect(c.destination)
      src.start(0, startSec, dur)
      startedAt = c.currentTime
      set({ peaks, durationSec: dur, progress: 0 })
      src.onended = () => {
        if (ctx === c) get().stop()
      }

      const tick = (): void => {
        if (ctx !== c) return
        const p = Math.min(1, (c.currentTime - startedAt) / dur)
        set({ progress: p })
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      get().stop()
    }
  }
}))
