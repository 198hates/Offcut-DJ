/**
 * BeatgridEditor — full-screen beat-alignment editor.
 *
 * Controls:
 *   Click / drag   — snap nearest beat to cursor (phase correction)
 *   Scroll         — pan left / right
 *   Ctrl+Scroll    — zoom (pivot on cursor)
 *   BPM ±          — nudge tempo
 *   ½ / ×2         — halve / double BPM
 *   Offset ±       — nudge phase ±1 ms / ±5 ms
 *   auto           — re-detect first beat by onset analysis
 *   save beatgrid  — commit to library DB
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { buildGridMarkers } from '../lib/beatgridEdit'
import { formatTime } from '../lib/format'
import type { Track, BeatgridMarker, PhraseSegment } from '@shared/types'

// Grid construction (single anchor + mid-track re-anchor) lives in
// lib/beatgridEdit.ts so it can be unit-tested; imported below.

// ── Audio helpers ─────────────────────────────────────────────────────────────
//
// Audio is decoded to mono float PCM by the main process (ffmpeg) rather than
// the renderer's Web Audio `decodeAudioData`, which throws "EncodingError" on
// formats DJs routinely use (FLAC, AIFF, ALAC). So every helper here works on a
// plain mono Float32Array plus its sample rate.

interface EditorPeaks {
  full: Float32Array
  low: Float32Array // low-pass (kick/bass) envelope — what you align beats to
}

// Per-bucket peaks for the full signal AND a low-passed (kick) envelope, both
// normalised to the full-signal max so kicks show as tall spikes against a
// faint full waveform. A one-pole low-pass (~150 Hz) isolates the kick.
function computeBandPeaks(mono: Float32Array, sampleRate: number, buckets: number): EditorPeaks {
  const full = new Float32Array(buckets)
  const low = new Float32Array(buckets)
  const n = mono.length
  if (n === 0) return { full, low }
  const spb = n / buckets
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate)
  let lp = 0
  for (let i = 0; i < n; i++) {
    const x = mono[i]
    lp += a * (x - lp)
    const b = Math.min(buckets - 1, Math.floor(i / spb))
    const af = x < 0 ? -x : x
    const al = lp < 0 ? -lp : lp
    if (af > full[b]) full[b] = af
    if (al > low[b]) low[b] = al
  }
  let max = 0
  for (let i = 0; i < buckets; i++) if (full[i] > max) max = full[i]
  if (max > 0) for (let i = 0; i < buckets; i++) { full[i] /= max; low[i] /= max }
  return { full, low }
}

function detectFirstBeatMs(mono: Float32Array, sampleRate: number, bpmHint: number): number {
  const sr = sampleRate
  const beatMs = 60000 / Math.max(60, bpmHint)
  const analyseSecs = Math.max(4, (beatMs * 8) / 1000)
  mono = mono.subarray(0, Math.min(mono.length, Math.floor(sr * analyseSecs)))

  const winN = Math.max(1, Math.floor(sr * 0.01))   // 10 ms windows
  const nFrames = Math.floor(mono.length / winN)
  if (nFrames < 4) return 0

  const rms = new Float32Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    let e = 0
    const end = Math.min(mono.length, (i + 1) * winN)
    for (let j = i * winN; j < end; j++) e += mono[j] * mono[j]
    rms[i] = Math.sqrt(e / (end - i * winN))
  }

  const onset = new Float32Array(nFrames)
  for (let i = 1; i < nFrames; i++) onset[i] = Math.max(0, rms[i] - rms[i - 1])

  const maxO = Math.max(...onset)
  const thr = maxO * 0.35
  const searchEnd = Math.min(nFrames, Math.floor(beatMs * 2 / 10))
  for (let i = 2; i < searchEnd; i++) {
    if (onset[i] >= thr) return (i * winN / sr) * 1000
  }
  return 0
}

// One metronome click at a scheduled audio-clock time. Downbeats are accented
// (higher pitch, louder) so the bar "1" is audible against the beats.
function playClick(ctx: AudioContext, when: number, accent: boolean): void {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.frequency.value = accent ? 2000 : 1200
  osc.connect(g).connect(ctx.destination)
  const dur = 0.04
  g.gain.setValueAtTime(0.0001, when)
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.28, when + 0.002)
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  osc.start(when)
  osc.stop(when + dur + 0.02)
}

// mm:ss.d from milliseconds (one decimal of seconds — enough to read a sweep).
/** ms → "m:ss.t" — delegates to the shared seconds-based formatter. */
const fmtTime = (ms: number): string => formatTime(ms / 1000)

// ── Canvas rendering ──────────────────────────────────────────────────────────

interface ViewState {
  startMs: number
  pps: number          // pixels per second
}

const PHRASE_COLORS: Record<PhraseSegment['label'], string> = {
  intro: '54,187,165', buildup: '230,170,60', drop: '224,94,59', chorus: '201,144,42',
  verse: '110,128,144', breakdown: '123,97,168', bridge: '74,155,111', outro: '120,120,120'
}

function drawEditor(
  canvas: HTMLCanvasElement,
  peaks: EditorPeaks,
  duration: number,
  markers: BeatgridMarker[],
  view: ViewState,
  anchorMs: number,
  hoveredMs: number | null,
  playheadMs: number,
  phrases: PhraseSegment[] | null,
  anchor2Ms: number | null,
): void {
  const dpr = window.devicePixelRatio || 1
  const W = canvas.offsetWidth
  const H = canvas.offsetHeight
  if (W === 0 || H === 0) return

  // Only resize if dimensions have actually changed (prevents flicker)
  const wantW = Math.round(W * dpr)
  const wantH = Math.round(H * dpr)
  if (canvas.width !== wantW) canvas.width  = wantW
  if (canvas.height !== wantH) canvas.height = wantH

  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  const visMs = (W / view.pps) * 1000
  const endMs = view.startMs + visMs
  const mid = (H - 18) / 2 // leave room for the ruler

  // ── Waveform: faint full signal + bright kick envelope ─────────────────────
  // The kick overlay is the thing you align beats to — making it stand out
  // (and dimming the rest) is what makes the grid legible.
  const BAR = Math.max(1, Math.floor(dpr))
  const nP = peaks.full.length
  for (let x = 0; x < W; x += BAR) {
    const tMs = view.startMs + (x / W) * visMs
    if (tMs < 0 || tMs > duration * 1000) continue
    const idx = Math.min(nP - 1, Math.floor((tMs / 1000 / duration) * nP))
    const fh = peaks.full[idx] * mid * 0.92
    if (fh > 0.5) {
      ctx.fillStyle = 'rgba(181,172,151,0.22)' // full signal — faint cream
      ctx.fillRect(x, mid - fh, BAR, fh * 2)
    }
    const lh = peaks.low[idx] * mid * 0.92
    if (lh > 0.5) {
      ctx.fillStyle = 'rgba(235,229,211,0.6)' // kick/bass — bright cream
      ctx.fillRect(x, mid - lh, BAR, lh * 2)
    }
  }

  // ── Beat marker lines ─────────────────────────────────────────────────────
  // White beats, bold terracotta downbeats with bar numbers — high contrast
  // against the cream waveform so the grid reads at a glance.
  ctx.font = `700 9px 'JetBrains Mono', monospace`
  ctx.textAlign = 'left'
  let barNo = 0
  for (const m of markers) {
    const onScreen = m.positionMs >= view.startMs - 200 && m.positionMs <= endMs + 200
    if (m.isDownbeat) barNo++
    if (!onScreen) continue
    const x = Math.round(((m.positionMs - view.startMs) / visMs) * W)
    if (m.isDownbeat) {
      ctx.fillStyle = 'rgba(216,106,74,0.95)' // downbeat — accent, full height
      ctx.fillRect(x, 0, 2, H - 18)
      ctx.fillStyle = 'rgba(216,106,74,0.85)'
      ctx.fillText(String(barNo), x + 4, 10)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.42)' // beat — thin white
      ctx.fillRect(x, 12, 1, H - 30)
    }
  }

  // ── Anchor handle (the chosen downbeat / "the 1") ─────────────────────────
  const anchorX = Math.round(((anchorMs - view.startMs) / visMs) * W)
  if (anchorX >= -8 && anchorX <= W + 8) {
    ctx.fillStyle = 'rgba(96,200,230,0.95)' // cyan — distinct from accent downbeats
    ctx.fillRect(anchorX - 1, 0, 2, H - 18)
    ctx.beginPath()
    ctx.moveTo(anchorX - 6, 0)
    ctx.lineTo(anchorX + 6, 0)
    ctx.lineTo(anchorX, 9)
    ctx.closePath()
    ctx.fill()
  }

  // ── Re-anchor handle (the re-drop / second downbeat) ──────────────────────
  if (anchor2Ms != null) {
    const a2x = Math.round(((anchor2Ms - view.startMs) / visMs) * W)
    if (a2x >= -8 && a2x <= W + 8) {
      ctx.fillStyle = 'rgba(216,106,200,0.95)' // magenta — distinct from the cyan "1"
      ctx.fillRect(a2x - 1, 0, 2, H - 18)
      ctx.beginPath()
      ctx.moveTo(a2x - 6, 0)
      ctx.lineTo(a2x + 6, 0)
      ctx.lineTo(a2x, 9)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ── Playhead ──────────────────────────────────────────────────────────────
  // Bright yellow vertical line tracking playback position — distinct from the
  // cyan anchor and terracotta downbeats so it reads clearly while sweeping.
  if (playheadMs >= view.startMs - 50 && playheadMs <= endMs + 50) {
    const px = Math.round(((playheadMs - view.startMs) / visMs) * W)
    ctx.fillStyle = 'rgba(255,214,64,0.95)'
    ctx.fillRect(px, 0, 1.5, H - 18)
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 8)
    ctx.closePath()
    ctx.fill()
  }

  // ── Hover ghost ───────────────────────────────────────────────────────────
  if (hoveredMs !== null) {
    const hx = Math.round(((hoveredMs - view.startMs) / visMs) * W)
    ctx.fillStyle = 'rgba(96,200,230,0.35)'
    ctx.fillRect(hx, 0, 1, H - 18)
  }

  // ── Time ruler ────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.15)'
  ctx.fillRect(0, H - 18, W, 18)

  const tickIntervalMs = visMs > 30000 ? 10000 : visMs > 10000 ? 5000 : visMs > 5000 ? 2000 : 1000
  const firstTick = Math.ceil(view.startMs / tickIntervalMs) * tickIntervalMs
  ctx.font = `400 9px 'JetBrains Mono', monospace`
  ctx.textAlign = 'left'
  for (let tMs = firstTick; tMs <= endMs; tMs += tickIntervalMs) {
    const x = Math.round(((tMs - view.startMs) / visMs) * W)
    const secs = tMs / 1000
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(x, H - 18, 1, 18)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, x + 3, H - 5)
  }

  // ── Phrase / structure strip (top) ─────────────────────────────────────────
  if (phrases?.length) {
    ctx.font = `600 9px 'JetBrains Mono', monospace`
    ctx.textAlign = 'left'
    for (const p of phrases) {
      const x0 = ((p.startMs - view.startMs) / visMs) * W
      const x1 = ((p.endMs - view.startMs) / visMs) * W
      if (x1 < 0 || x0 > W) continue
      const rgb = PHRASE_COLORS[p.label]
      const cx0 = Math.max(0, x0)
      const w = Math.min(W, x1) - cx0
      ctx.fillStyle = `rgba(${rgb},0.55)`
      ctx.fillRect(cx0, 0, w, 11)            // top label band
      ctx.fillStyle = `rgba(${rgb},0.05)`
      ctx.fillRect(cx0, 11, w, H - 29)       // faint region tint under the waveform
      ctx.fillStyle = `rgba(${rgb},0.8)`
      ctx.fillRect(Math.round(x0), 0, 1, H - 18) // boundary line
      if (w > 26) {
        ctx.fillStyle = 'rgba(20,16,12,0.9)'
        ctx.fillText(p.label, cx0 + 3, 8)
      }
    }
  }

  ctx.restore()
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  track: Track
  onSave: (beatgrid: BeatgridMarker[], bpm: number) => void
  onClose: () => void
}

const DEFAULT_PPS = 80

export function BeatgridEditor({ track, onSave, onClose }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef(0)

  const [peaks,    setPeaks]    = useState<EditorPeaks | null>(null)
  const [duration, setDuration] = useState(track.durationSeconds ?? 0)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // ── Initial state — prefer analysedBeatgrid seed when available ───────────
  const initBpm: number = (
    track.analysedBeatgrid?.medianBpm ??
    track.bpm ??
    128
  )
  // The grid is defined by ONE thing: the absolute position of bar 1's
  // downbeat (the "1"). Everything else — beat phase and which beats are
  // downbeats — derives from it. Seed it from an existing downbeat, else the
  // first beat, else the auto-analysed first beat.
  const initAnchor: number = (() => {
    const db = track.beatgrid.find((m) => m.isDownbeat)
    if (db) return db.positionMs
    if (track.beatgrid.length > 0) return track.beatgrid[0].positionMs
    return track.analysedBeatgrid?.firstBeatMs ?? 0
  })()

  const [bpm,      setBpm]      = useState(initBpm)
  // anchorMs = absolute ms of the chosen downbeat (bar 1). Click a kick to set it.
  const [anchorMs, setAnchorMs] = useState(initAnchor)
  // Optional second downbeat: re-phases the grid from here on (a remix re-drop
  // that isn't a whole number of bars). null = single uniform grid.
  const [anchor2Ms, setAnchor2Ms] = useState<number | null>(null)
  // When armed, the next click sets the re-anchor instead of the "1".
  const [reanchorArmed, setReanchorArmed] = useState(false)
  const [view,     setView]     = useState<ViewState>({ startMs: 0, pps: DEFAULT_PPS })
  const [hovered,  setHovered]  = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  // ── Playback (monitor alignment by ear + a moving playhead) ───────────────
  const [playing,    setPlaying]    = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [metronome,  setMetronome]  = useState(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioBufRef = useRef<AudioBuffer | null>(null)
  const srcRef      = useRef<AudioBufferSourceNode | null>(null)
  const playRafRef  = useRef(0)
  const playStartRef = useRef({ ctxTime: 0, headMs: 0 })
  const playingRef  = useRef(false)
  // Metronome scheduling state (read inside the rAF tick via refs).
  const metronomeRef = useRef(false)
  const markersRef   = useRef<BeatgridMarker[]>([])
  const clickIdxRef  = useRef(0)

  // Derive the generator inputs (first-beat phase + which beat-of-4 is the
  // downbeat) from the single anchor, so a beat always lands ON the anchor and
  // that beat is flagged as the "1".
  const markers = useMemo(
    () => buildGridMarkers(bpm, duration * 1000, anchorMs, anchor2Ms),
    [bpm, duration, anchorMs, anchor2Ms]
  )
  markersRef.current = markers
  useEffect(() => { metronomeRef.current = metronome }, [metronome])

  // ── Load audio ────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    window.api.audio.decodePcm(track.filePath)
      .then(({ samples, sampleRate }) => {
        if (cancelled) return
        setPeaks(computeBandPeaks(samples, sampleRate, 4000))
        setDuration(samples.length / sampleRate)
        setLoading(false)

        // Keep a playable AudioBuffer (mono, decoded rate) for the playhead.
        const ctx = audioCtxRef.current ?? (audioCtxRef.current = new AudioContext())
        const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate)
        buf.getChannelData(0).set(samples)
        audioBufRef.current = buf

        // Auto-detect first beat only when no grid exists at all
        if (track.beatgrid.length === 0 && !track.analysedBeatgrid) {
          setAnchorMs(detectFirstBeatMs(samples, sampleRate, initBpm))
        }
      })
      .catch((e) => {
        if (!cancelled) { setLoading(false); setError(String(e)) }
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.filePath])

  // ── Redraw ────────────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    if (!canvasRef.current || !peaks) return
    drawEditor(canvasRef.current, peaks, duration, markers, view, anchorMs, hovered, playheadMs, track.phrases, anchor2Ms)
  }, [peaks, duration, markers, view, anchorMs, hovered, playheadMs, anchor2Ms])

  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(redraw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [redraw])

  // ResizeObserver — re-draw when container changes size
  useEffect(() => {
    const el = canvasRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(redraw)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [redraw])

  // ── Wheel — must be a native listener with { passive: false } ─────────────
  // React 17+ attaches wheel handlers passively; e.preventDefault() inside a
  // passive listener is silently ignored by Chromium/Electron, so zooming and
  // panning would not prevent the outer container from scrolling.

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // Zoom — pivot on cursor
        const rect = canvas.getBoundingClientRect()
        const frac = (e.clientX - rect.left) / rect.width
        setView((v) => {
          const pivotMs = v.startMs + frac * (rect.width / v.pps) * 1000
          const newPps  = Math.max(10, Math.min(500, v.pps * (e.deltaY < 0 ? 1.15 : 0.87)))
          const newVisMs = (rect.width / newPps) * 1000
          const newStart = Math.max(0, pivotMs - frac * newVisMs)
          return { startMs: newStart, pps: newPps }
        })
      } else {
        // Pan
        setView((v) => {
          const visMs = (canvas.offsetWidth / v.pps) * 1000
          const delta = (e.deltaY / 120) * visMs * 0.2 + (e.deltaX / 120) * visMs * 0.1
          const maxStart = Math.max(0, duration * 1000 - visMs)
          return { ...v, startMs: Math.max(0, Math.min(maxStart, v.startMs + delta)) }
        })
      }
    }

    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [duration])   // duration is the only external dep; view is read via setState updater

  // ── Click / drag — place the downbeat ─────────────────────────────────────

  const msAtX = useCallback((clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const frac = (clientX - rect.left) / rect.width
    return view.startMs + frac * (rect.width / view.pps) * 1000
  }, [view])

  // Snap the click to the loudest kick within ±half a beat, so clicking "on the
  // kick" lands precisely on its transient instead of wherever the cursor fell.
  const snapToKick = useCallback((clickMs: number): number => {
    if (!peaks || duration <= 0) return clickMs
    const nP = peaks.low.length
    const msPerBucket = (duration * 1000) / nP
    const win = Math.max(1, Math.round((30000 / bpm) / msPerBucket))   // ±half a beat
    const center = Math.round(clickMs / msPerBucket)
    let bestIdx = center
    let bestVal = -1
    for (let i = Math.max(0, center - win); i <= Math.min(nP - 1, center + win); i++) {
      if (peaks.low[i] > bestVal) { bestVal = peaks.low[i]; bestIdx = i }
    }
    // Only snap if there's a real kick here; otherwise keep the exact click.
    return bestVal > 0.12 ? bestIdx * msPerBucket : clickMs
  }, [peaks, duration, bpm])

  // ── Playback transport ────────────────────────────────────────────────────

  const stopPlayback = useCallback((): void => {
    if (srcRef.current) {
      try { srcRef.current.onended = null; srcRef.current.stop() } catch { /* already stopped */ }
      srcRef.current = null
    }
    cancelAnimationFrame(playRafRef.current)
    playingRef.current = false
    setPlaying(false)
  }, [])

  // Schedule any beat clicks falling in the next ~120 ms against the audio clock
  // (a short look-ahead so they're sample-accurate, not rAF-jittered).
  const scheduleClicks = useCallback((): void => {
    const ctx = audioCtxRef.current
    if (!ctx || !metronomeRef.current) return
    const ms = markersRef.current
    const horizon = ctx.currentTime + 0.12
    while (clickIdxRef.current < ms.length) {
      const m = ms[clickIdxRef.current]
      const when = playStartRef.current.ctxTime + (m.positionMs - playStartRef.current.headMs) / 1000
      if (when > horizon) break
      if (when >= ctx.currentTime - 0.005) playClick(ctx, when, !!m.isDownbeat)
      clickIdxRef.current++
    }
  }, [])

  const tick = useCallback((): void => {
    const ctx = audioCtxRef.current
    if (!ctx || !playingRef.current) return
    const durMs = duration * 1000
    let head = playStartRef.current.headMs + (ctx.currentTime - playStartRef.current.ctxTime) * 1000
    if (head >= durMs) { setPlayheadMs(durMs); stopPlayback(); return }
    scheduleClicks()
    setPlayheadMs(head)
    // Follow-scroll: keep the playhead on screen as it sweeps.
    setView((v) => {
      const w = canvasRef.current?.offsetWidth ?? 0
      if (w === 0) return v
      const visMs = (w / v.pps) * 1000
      if (head < v.startMs || head > v.startMs + visMs * 0.85) {
        const maxStart = Math.max(0, durMs - visMs)
        return { ...v, startMs: Math.max(0, Math.min(maxStart, head - visMs * 0.3)) }
      }
      return v
    })
    playRafRef.current = requestAnimationFrame(tick)
  }, [duration, stopPlayback, scheduleClicks])

  const startPlayback = useCallback((fromMs: number): void => {
    const ctx = audioCtxRef.current
    const buf = audioBufRef.current
    if (!ctx || !buf) return
    if (srcRef.current) {
      try { srcRef.current.onended = null; srcRef.current.stop() } catch { /* already stopped */ }
      srcRef.current = null
    }
    void ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    gain.gain.value = 0.85
    src.connect(gain).connect(ctx.destination)
    src.start(0, Math.max(0, Math.min(buf.duration - 0.01, fromMs / 1000)))
    srcRef.current = src
    playStartRef.current = { ctxTime: ctx.currentTime, headMs: fromMs }
    // Start the metronome pointer at the first beat from here.
    const firstIdx = markersRef.current.findIndex((m) => m.positionMs >= fromMs)
    clickIdxRef.current = firstIdx < 0 ? markersRef.current.length : firstIdx
    playingRef.current = true
    setPlaying(true)
    cancelAnimationFrame(playRafRef.current)
    playRafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const togglePlay = useCallback((): void => {
    if (playingRef.current) stopPlayback()
    else startPlayback(playheadMs >= duration * 1000 - 1 ? 0 : playheadMs)
  }, [playheadMs, duration, startPlayback, stopPlayback])

  // Toggle the click track. When enabling mid-playback, re-point the scheduler
  // at the current playhead so it doesn't replay every beat since play started.
  const toggleMetronome = useCallback((): void => {
    setMetronome((on) => {
      const next = !on
      if (next && playingRef.current) {
        const ms = markersRef.current
        const idx = ms.findIndex((m) => m.positionMs >= playheadMs)
        clickIdxRef.current = idx < 0 ? ms.length : idx
      }
      return next
    })
  }, [playheadMs])

  // Space = play/pause, Escape = close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, onClose])

  // Tear down audio on unmount — stop playback and free the AudioContext.
  useEffect(() => () => {
    if (srcRef.current) { try { srcRef.current.stop() } catch { /* already stopped */ } }
    cancelAnimationFrame(playRafRef.current)
    if (audioCtxRef.current) void audioCtxRef.current.close()
  }, [])

  // ── Click / drag — place the downbeat + cue playback there ────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const ms = Math.max(0, snapToKick(msAtX(e.clientX)))
    if (reanchorArmed) {
      // Set the re-anchor (the re-drop) — one click, no drag.
      setAnchor2Ms(ms)
      setReanchorArmed(false)
    } else {
      setDragging(true)
      setAnchorMs(ms)           // place the "1"
    }
    setPlayheadMs(ms)           // …and cue playback there
    if (playingRef.current) startPlayback(ms)
  }, [msAtX, snapToKick, startPlayback, reanchorArmed])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const ms = msAtX(e.clientX)
    setHovered(ms)
    if (dragging) setAnchorMs(Math.max(0, ms))   // free drag, no kick-snap mid-drag
  }, [msAtX, dragging])

  const handleMouseUp   = useCallback(() => setDragging(false), [])
  const handleMouseLeave = useCallback(() => { setHovered(null); setDragging(false) }, [])

  // ── BPM and anchor nudge ──────────────────────────────────────────────────

  const nudgeBpm = (delta: number): void =>
    setBpm((b) => Math.round((b + delta) * 1000) / 1000)

  // Micro-shift the whole grid (and the "1" with it) by ±ms.
  const nudgeAnchor = (deltaMs: number): void =>
    setAnchorMs((a) => Math.max(0, a + deltaMs))

  // Move the downbeat to the previous / next beat without changing the phase.
  const nudgeDownbeat = (dir: number): void =>
    setAnchorMs((a) => Math.max(0, a + dir * (60000 / bpm)))

  const autoDetect = async (): Promise<void> => {
    setLoading(true)
    try {
      const { samples, sampleRate } = await window.api.audio.decodePcm(track.filePath)
      setAnchorMs(detectFirstBeatMs(samples, sampleRate, bpm))
    } catch { /* ignore */ }
    setLoading(false)
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = (): void =>
    onSave(buildGridMarkers(bpm, duration * 1000, anchorMs, anchor2Ms), bpm)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-8"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="flex flex-col w-full max-w-5xl h-[72vh] max-h-[680px] rounded-lg border border-border/40 bg-chassis shadow-2xl overflow-hidden"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border/30 bg-chassis-soft">

        {/* Title row + actions */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-accent">beatgrid editor</p>
            <p className="text-[13px] text-ink truncate mt-0.5">{track.title} · {track.artist}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose}
              className="px-3 py-1.5 text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-border/40 rounded transition-colors">
              cancel
            </button>
            <button onClick={handleSave}
              className="px-3 py-1.5 text-[12px] uppercase tracking-[0.1em] bg-accent hover:bg-accent/90 text-paper rounded transition-colors">
              save beatgrid
            </button>
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-x-4 gap-y-2 mt-2.5 flex-wrap">

        {/* Transport */}
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={togglePlay} disabled={loading || !!error}
            className="px-2.5 py-1 text-[12px] uppercase tracking-[0.1em] text-accent hover:text-paper hover:bg-accent border border-accent/50 rounded transition-colors disabled:opacity-40 min-w-[4.5rem] text-center">
            {playing ? '❚❚ pause' : '▶ play'}
          </button>
          <span className="text-[12px] text-muted tabular-nums select-none">
            {fmtTime(playheadMs)}<span className="text-muted/40"> / {fmtTime(duration * 1000)}</span>
          </span>
          <button onClick={toggleMetronome} title="metronome click on the beat"
            className={`px-2 py-1 text-[12px] uppercase tracking-[0.1em] border rounded transition-colors ${
              metronome
                ? 'text-paper bg-accent border-accent'
                : 'text-muted hover:text-ink border-border/35'
            }`}>
            click
          </button>
        </div>

        {/* BPM */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[12px] text-muted uppercase tracking-[0.12em] mr-1">bpm</span>
          {([-1, -0.1, -0.01] as const).map((d) => (
            <button key={d} onClick={() => nudgeBpm(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              {d}
            </button>
          ))}
          <span className="px-2 py-1 text-[13px] font-bold text-ink tabular-nums select-none min-w-[4.5rem] text-center">
            {bpm.toFixed(2)}
          </span>
          {([0.01, 0.1, 1] as const).map((d) => (
            <button key={d} onClick={() => nudgeBpm(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              +{d}
            </button>
          ))}
          <button onClick={() => setBpm((b) => Math.round(b / 2 * 100) / 100)}
            className="ml-1 px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">½</button>
          <button onClick={() => setBpm((b) => Math.round(b * 2 * 100) / 100)}
            className="px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">×2</button>
        </div>

        {/* Fine-align — micro-shift the whole grid by ±ms */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[12px] text-muted uppercase tracking-[0.12em] mr-1">nudge</span>
          {([-5, -1] as const).map((d) => (
            <button key={d} onClick={() => nudgeAnchor(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              {d}ms
            </button>
          ))}
          <span className="px-2 py-1 text-[13px] text-ink tabular-nums select-none min-w-[4rem] text-center">
            {(anchorMs / 1000).toFixed(3)}s
          </span>
          {([1, 5] as const).map((d) => (
            <button key={d} onClick={() => nudgeAnchor(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              +{d}ms
            </button>
          ))}
          <button onClick={autoDetect} disabled={loading}
            className="ml-1 px-2 py-1 text-[12px] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded transition-colors disabled:opacity-40">
            auto
          </button>
        </div>

        {/* Downbeat — move the "1" to the previous / next beat */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[12px] text-accent uppercase tracking-[0.12em] mr-1">the 1</span>
          <button onClick={() => nudgeDownbeat(-1)} title="move downbeat one beat earlier"
            className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">◀ beat</button>
          <button onClick={() => nudgeDownbeat(1)} title="move downbeat one beat later"
            className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">beat ▶</button>
        </div>

        {/* Re-anchor — fix a mid-track phase shift (remix re-drop after a middle-8) */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[12px] uppercase tracking-[0.12em] mr-1" style={{ color: 'rgb(216,106,200)' }}>re-drop</span>
          {anchor2Ms == null ? (
            <button
              onClick={() => setReanchorArmed((v) => !v)}
              title="Click, then click the beat where the track drops back in out of time, to re-phase the grid from there"
              className={`px-2 py-1 text-[12px] rounded border transition-colors ${reanchorArmed ? 'border-[rgb(216,106,200)] text-[rgb(216,106,200)] bg-[rgba(216,106,200,0.12)]' : 'text-muted hover:text-ink border-border/35'}`}
            >
              {reanchorArmed ? 'click the re-drop…' : '+ re-anchor'}
            </button>
          ) : (
            <>
              <span className="px-2 py-1 text-[12px] tabular-nums" style={{ color: 'rgb(216,106,200)' }}>
                {(anchor2Ms / 1000).toFixed(3)}s
              </span>
              <button onClick={() => setAnchor2Ms(null)} title="remove the re-anchor"
                className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">clear</button>
            </>
          )}
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setView((v) => ({ ...v, pps: Math.max(10, v.pps / 1.5) }))}
            className="px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">−</button>
          <span className="text-[12px] text-muted w-12 text-center tabular-nums">{Math.round(view.pps)} px/s</span>
          <button onClick={() => setView((v) => ({ ...v, pps: Math.min(500, v.pps * 1.5) }))}
            className="px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">+</button>
        </div>

        </div>
      </div>

      {/* ── Waveform canvas ──────────────────────────────────────────────────── */}
      <div className="flex-1 relative bg-[#0a0a12] overflow-hidden" style={{ minHeight: 0 }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[13px] text-muted uppercase tracking-[0.15em]">decoding audio…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[13px] text-red-500">{error}</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />
        {!loading && !error && (
          <div className="absolute bottom-6 right-3 pointer-events-none">
            <span className="text-[11px] text-muted/40 uppercase tracking-[0.15em]">
              click a kick to set the 1 · space to play · ctrl+scroll to zoom
            </span>
          </div>
        )}
      </div>

      {/* ── Scrollbar ────────────────────────────────────────────────────────── */}
      {!loading && !error && duration > 0 && (
        <div className="shrink-0 h-2 bg-ink/[0.15] relative">
          <div
            className="absolute top-0 h-full bg-accent/30 rounded"
            style={{
              left:  `${(view.startMs / (duration * 1000)) * 100}%`,
              width: `${Math.min(100, (canvasRef.current?.offsetWidth ?? 0) / view.pps / duration * 100)}%`,
            }}
          />
        </div>
      )}

      {/* ── Info bar ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-4 px-4 py-1.5 border-t border-border/20 bg-chassis-soft">
        <span className="text-[11px] text-muted/50 uppercase tracking-[0.15em]">
          {markers.length} beats · {Math.round(markers.length / 4)} bars ·{' '}
          {duration > 0
            ? `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}`
            : '—'}
        </span>
        <span className="text-[11px] text-muted/40 ml-auto">
          <span style={{ color: 'rgba(96,200,230,0.95)' }}>▏</span> anchor ·{' '}
          <span style={{ color: 'rgba(216,106,74,0.95)' }}>▏</span> downbeat ·{' '}
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>▏</span> beat ·{' '}
          <span style={{ color: 'rgba(235,229,211,0.7)' }}>▮</span> kick
        </span>
      </div>
      </div>
    </div>
  )
}
