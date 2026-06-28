/**
 * trackPreviewStore — shared preview engine for library rows.
 *
 * Two ways in:
 *   • toggle(track)        — Space-key audition: a 30s clip from the Mix-In cue
 *                            (or 0). Reports `peaks` (the clip's 480-bar shape)
 *                            and `progress` (0..1 across the clip) for the
 *                            LibraryMini preview bar.
 *   • previewAt(track,frac)— Rekordbox-style click-to-preview: plays the FULL
 *                            track from the clicked fraction and keeps playing,
 *                            so a second click just seeks. The decoded buffer is
 *                            cached, so seeking is instant (no re-decode).
 *
 * Both modes publish absolute position via `posSec` / `trackDurationSec`, which
 * the library row waveform uses to draw a playhead over the full overview.
 * Only one preview plays at a time (zustand-managed).
 */

import { create } from 'zustand'
import type { Track } from '@shared/types'

const PREVIEW_SECONDS = 30
const BARS = 480

let ctx: AudioContext | null = null
let src: AudioBufferSourceNode | null = null
let buf: AudioBuffer | null = null
let bufId: string | null = null
let raf = 0
let startedAt = 0      // ctx.currentTime when the current source started
let startOffset = 0    // buffer offset (sec) the current source started from

interface TrackPreviewState {
  previewId: string | null
  peaks: Float32Array | null
  /** 0..1 across the previewed clip (toggle mode). */
  progress: number
  /** Length of the previewed clip in seconds (toggle mode). */
  durationSec: number
  /** Absolute playback position in seconds within the full track. */
  posSec: number
  /** Full track duration in seconds (0 until decoded). */
  trackDurationSec: number
  toggle: (track: Track, durationSec?: number) => Promise<void>
  previewAt: (track: Track, frac: number) => Promise<void>
  stop: () => void
}

function teardown(): void {
  cancelAnimationFrame(raf)
  if (src) { try { src.onended = null; src.stop() } catch { /* ignore */ } src = null }
  if (ctx) { try { ctx.close() } catch { /* ignore */ } ctx = null }
  buf = null
  bufId = null
}

// Decode via the main-process ffmpeg path (audio:decodePcm) rather than Web
// Audio's decodeAudioData, which can't handle AIFF/ALAC and other formats the
// deck plays fine. Returns a mono AudioBuffer at the context's sample rate.
async function decodeMonoBuffer(filePath: string, c: AudioContext): Promise<AudioBuffer> {
  const { samples, sampleRate } = await window.api.audio.decodePcm(filePath, c.sampleRate)
  const f32 = samples instanceof Float32Array ? samples : new Float32Array(samples)
  if (!f32.length) throw new Error('empty decode')
  const b = c.createBuffer(1, f32.length, sampleRate)
  b.getChannelData(0).set(f32)
  return b
}

export const useTrackPreview = create<TrackPreviewState>((set, get) => ({
  previewId: null,
  peaks: null,
  progress: 0,
  durationSec: 0,
  posSec: 0,
  trackDurationSec: 0,

  stop: () => {
    teardown()
    set({ previewId: null, peaks: null, progress: 0, durationSec: 0, posSec: 0, trackDurationSec: 0 })
  },

  toggle: async (track: Track, durationSec = PREVIEW_SECONDS) => {
    if (get().previewId === track.id) {
      get().stop()
      return
    }
    get().stop()
    set({ previewId: track.id, peaks: null, progress: 0, durationSec: 0, posSec: 0, trackDurationSec: 0 })

    try {
      const c = new AudioContext()
      ctx = c
      const b = await decodeMonoBuffer(track.filePath, c)
      // Bail if a different preview was started while we were decoding.
      if (get().previewId !== track.id || ctx !== c) {
        try { c.close() } catch { /* ignore */ }
        return
      }
      buf = b
      bufId = track.id

      const mixIn = track.cuePoints.find(
        (cue) => cue.type === 'hotcue' && /mix.?in/i.test(cue.label)
      )
      const startSec = mixIn ? mixIn.positionMs / 1000 : 0
      const dur = Math.min(durationSec, Math.max(1, b.duration - startSec))

      // Overview peaks across the previewed window.
      const data = b.getChannelData(0)
      const sr = b.sampleRate
      const s0 = Math.floor(startSec * sr)
      const s1 = Math.min(data.length, Math.floor((startSec + dur) * sr))
      const block = Math.max(1, Math.floor((s1 - s0) / BARS))
      const peaks = new Float32Array(BARS)
      for (let i = 0; i < BARS; i++) {
        const a = s0 + i * block
        const e = Math.min(s1, a + block)
        let m = 0
        for (let j = a; j < e; j++) { const v = Math.abs(data[j]); if (v > m) m = v }
        peaks[i] = m
      }

      const s = c.createBufferSource()
      s.buffer = b
      s.connect(c.destination)
      s.start(0, startSec, dur)
      src = s
      startedAt = c.currentTime
      startOffset = startSec
      set({ peaks, durationSec: dur, progress: 0, posSec: startSec, trackDurationSec: b.duration })
      s.onended = () => { if (ctx === c) get().stop() }

      const tick = (): void => {
        if (ctx !== c) return
        const el = c.currentTime - startedAt
        const p = Math.min(1, el / dur)
        set({ progress: p, posSec: startOffset + el })
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      get().stop()
    }
  },

  // Rekordbox-style: click the row waveform to play from that point; clicking
  // again on the same track just seeks (the buffer is already decoded).
  previewAt: async (track: Track, frac: number) => {
    const f = Math.max(0, Math.min(0.999, frac))

    // Same track already decoded → seek without re-reading/decoding.
    if (get().previewId === track.id && ctx && buf && bufId === track.id) {
      const c = ctx
      const offset = f * buf.duration
      if (src) { try { src.onended = null; src.stop() } catch { /* ignore */ } }
      const s = c.createBufferSource()
      s.buffer = buf
      s.connect(c.destination)
      s.start(0, offset)
      src = s
      startedAt = c.currentTime
      startOffset = offset
      set({ peaks: null, durationSec: 0, posSec: offset })
      s.onended = () => { if (ctx === c) get().stop() }
      cancelAnimationFrame(raf)
      const tick = (): void => {
        if (ctx !== c || !buf) return
        const pos = startOffset + (c.currentTime - startedAt)
        set({ posSec: pos })
        if (pos < buf.duration) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return
    }

    // New track.
    get().stop()
    set({ previewId: track.id, peaks: null, progress: 0, durationSec: 0, posSec: 0, trackDurationSec: 0 })
    try {
      const c = new AudioContext()
      ctx = c
      const b = await decodeMonoBuffer(track.filePath, c)
      if (get().previewId !== track.id || ctx !== c) {
        try { c.close() } catch { /* ignore */ }
        return
      }
      buf = b
      bufId = track.id
      const offset = f * b.duration
      const s = c.createBufferSource()
      s.buffer = b
      s.connect(c.destination)
      s.start(0, offset)
      src = s
      startedAt = c.currentTime
      startOffset = offset
      set({ posSec: offset, trackDurationSec: b.duration })
      s.onended = () => { if (ctx === c) get().stop() }

      const tick = (): void => {
        if (ctx !== c || !buf) return
        const pos = startOffset + (c.currentTime - startedAt)
        set({ posSec: pos })
        if (pos < buf.duration) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      get().stop()
    }
  }
}))
