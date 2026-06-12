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
import { generateBeatgrid } from '../lib/compatibility'
import type { Track, BeatgridMarker } from '@shared/types'

// ── Audio helpers ─────────────────────────────────────────────────────────────

function mixToMono(buf: AudioBuffer, limitSamples?: number): Float32Array {
  const len = limitSamples ? Math.min(buf.length, limitSamples) : buf.length
  const mono = new Float32Array(len)
  const inv = 1 / buf.numberOfChannels
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) mono[i] += d[i] * inv
  }
  return mono
}

function computePeaks(buf: AudioBuffer, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets)
  const spb = buf.length / buckets
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < buckets; i++) {
      const s = Math.floor(i * spb), e = Math.floor((i + 1) * spb)
      for (let j = s; j < e; j++) {
        const a = Math.abs(data[j])
        if (a > peaks[i]) peaks[i] = a
      }
    }
  }
  return peaks
}

function detectFirstBeatMs(buf: AudioBuffer, bpmHint: number): number {
  const sr = buf.sampleRate
  const beatMs = 60000 / Math.max(60, bpmHint)
  const analyseSecs = Math.min(buf.duration, Math.max(4, (beatMs * 8) / 1000))
  const mono = mixToMono(buf, Math.floor(sr * analyseSecs))

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

// ── Canvas rendering ──────────────────────────────────────────────────────────

interface ViewState {
  startMs: number
  pps: number          // pixels per second
}

function drawEditor(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  duration: number,
  markers: BeatgridMarker[],
  view: ViewState,
  offsetMs: number,
  hoveredMs: number | null,
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
  const mid = H / 2

  // ── Waveform bars ─────────────────────────────────────────────────────────
  const BAR = Math.max(1, Math.floor(dpr))
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  for (let x = 0; x < W; x += BAR) {
    const tMs = view.startMs + (x / W) * visMs
    if (tMs < 0 || tMs > duration * 1000) continue
    const idx = Math.min(peaks.length - 1, Math.floor((tMs / 1000 / duration) * peaks.length))
    const bh = peaks[idx] * mid * 0.88
    if (bh < 0.5) continue
    ctx.fillRect(x, mid - bh, BAR, bh * 2)
  }

  // ── Beat marker lines ─────────────────────────────────────────────────────
  for (const m of markers) {
    if (m.positionMs < view.startMs - 200 || m.positionMs > endMs + 200) continue
    const x = Math.round(((m.positionMs - view.startMs) / visMs) * W)

    // Skip the anchor beat — drawn separately below
    if (Math.abs(m.positionMs - offsetMs) < 2) continue

    if (m.isDownbeat) {
      ctx.fillStyle = 'rgba(255,255,255,0.80)'
      ctx.fillRect(x, 0, 1, H * 0.55)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillRect(x, H * 0.55, 1, H * 0.45)
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillRect(x, 0, 1, H * 0.30)
    }
  }

  // ── Anchor handle (the normalised first-beat position) ────────────────────
  // offsetMs is always in [0, beatMs), so it's always visible near the start
  const anchorX = Math.round(((offsetMs - view.startMs) / visMs) * W)
  if (anchorX >= -4 && anchorX <= W + 4) {
    ctx.fillStyle = 'rgba(216,106,74,0.9)'
    ctx.fillRect(anchorX, 0, 2, H)
    // Triangle cap
    ctx.beginPath()
    ctx.moveTo(anchorX - 6, 0)
    ctx.lineTo(anchorX + 7, 0)
    ctx.lineTo(anchorX + 1, 10)
    ctx.closePath()
    ctx.fillStyle = 'rgba(216,106,74,0.95)'
    ctx.fill()
  }

  // ── Hover ghost ───────────────────────────────────────────────────────────
  if (hoveredMs !== null) {
    const hx = Math.round(((hoveredMs - view.startMs) / visMs) * W)
    ctx.fillStyle = 'rgba(216,106,74,0.25)'
    ctx.fillRect(hx, 0, 1, H)
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

  const [peaks,    setPeaks]    = useState<Float32Array | null>(null)
  const [duration, setDuration] = useState(track.durationSeconds ?? 0)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // ── Initial state — prefer analysedBeatgrid seed when available ───────────
  const initBpm: number = (
    track.analysedBeatgrid?.medianBpm ??
    track.bpm ??
    128
  )
  const initOffset: number = (
    track.beatgrid.length > 0
      ? track.beatgrid[0].positionMs          // existing manual grid
      : track.analysedBeatgrid?.firstBeatMs   // seed from auto-analysis
        ?? 0
  )

  const [bpm,      setBpm]      = useState(initBpm)
  const [offsetMs, setOffsetMs] = useState(initOffset)
  const [view,     setView]     = useState<ViewState>({ startMs: 0, pps: DEFAULT_PPS })
  const [hovered,  setHovered]  = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const markers = useMemo(
    () => generateBeatgrid(bpm, offsetMs, duration * 1000),
    [bpm, offsetMs, duration]
  )

  // ── Load audio ────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    const actx = new AudioContext()

    window.api.audio.readFile(track.filePath)
      .then((ab) => actx.decodeAudioData(ab))
      .then((buf) => {
        if (cancelled) return
        setPeaks(computePeaks(buf, 4000))
        setDuration(buf.duration)
        setLoading(false)

        // Auto-detect first beat only when no grid exists at all
        if (track.beatgrid.length === 0 && !track.analysedBeatgrid) {
          setOffsetMs(detectFirstBeatMs(buf, initBpm))
        }
      })
      .catch((e) => {
        if (!cancelled) { setLoading(false); setError(String(e)) }
      })

    return () => { cancelled = true; actx.close() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.filePath])

  // ── Redraw ────────────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    if (!canvasRef.current || !peaks) return
    drawEditor(canvasRef.current, peaks, duration, markers, view, offsetMs, hovered)
  }, [peaks, duration, markers, view, offsetMs, hovered])

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

  // ── Click / drag — phase snap ─────────────────────────────────────────────

  const msAtX = useCallback((clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const frac = (clientX - rect.left) / rect.width
    return view.startMs + frac * (rect.width / view.pps) * 1000
  }, [view])

  const snapBeatToMs = useCallback((clickMs: number): void => {
    // Make the beat grid land exactly on clickMs.
    //
    // Beat positions are: offsetMs + n*beatMs for integer n.
    // We want some beat to fall at clickMs, which means:
    //   offsetMs = clickMs mod beatMs
    //
    // The modulo keeps offsetMs in [0, beatMs), so the orange anchor is
    // always visible near the start of the track.
    // (The old code subtracted beatMs when offset > beatMs/2, producing a
    //  negative offsetMs and making the anchor invisible — that was wrong.)
    const beatMs = 60000 / bpm
    const raw    = clickMs % beatMs
    setOffsetMs(raw < 0 ? raw + beatMs : raw)    // guard against negative clickMs
  }, [bpm])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    snapBeatToMs(msAtX(e.clientX))
  }, [msAtX, snapBeatToMs])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const ms = msAtX(e.clientX)
    setHovered(ms)
    if (dragging) snapBeatToMs(ms)
  }, [msAtX, snapBeatToMs, dragging])

  const handleMouseUp   = useCallback(() => setDragging(false), [])
  const handleMouseLeave = useCallback(() => { setHovered(null); setDragging(false) }, [])

  // ── BPM and offset nudge ──────────────────────────────────────────────────

  const nudgeBpm = (delta: number): void =>
    setBpm((b) => Math.round((b + delta) * 1000) / 1000)

  const nudgeOffset = (deltaMs: number): void =>
    setOffsetMs((o) => {
      const beatMs = 60000 / bpm
      const raw = (o + deltaMs) % beatMs
      return raw < 0 ? raw + beatMs : raw
    })

  const autoDetect = async (): Promise<void> => {
    setLoading(true)
    try {
      const ab  = await window.api.audio.readFile(track.filePath)
      const actx = new AudioContext()
      const buf  = await actx.decodeAudioData(ab)
      setOffsetMs(detectFirstBeatMs(buf, bpm))
      await actx.close()
    } catch { /* ignore */ }
    setLoading(false)
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = (): void =>
    onSave(generateBeatgrid(bpm, offsetMs, duration * 1000), bpm)

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
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border/30 bg-chassis-soft flex-wrap">

        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-accent">beatgrid editor</p>
          <p className="text-[13px] text-ink truncate mt-0.5">{track.title} · {track.artist}</p>
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

        {/* Offset */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[12px] text-muted uppercase tracking-[0.12em] mr-1">offset</span>
          {([-5, -1] as const).map((d) => (
            <button key={d} onClick={() => nudgeOffset(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              {d}ms
            </button>
          ))}
          <span className="px-2 py-1 text-[13px] text-ink tabular-nums select-none min-w-[4rem] text-center">
            {(offsetMs / 1000).toFixed(3)}s
          </span>
          {([1, 5] as const).map((d) => (
            <button key={d} onClick={() => nudgeOffset(d)}
              className="px-1.5 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">
              +{d}ms
            </button>
          ))}
          <button onClick={autoDetect} disabled={loading}
            className="ml-1 px-2 py-1 text-[12px] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded transition-colors disabled:opacity-40">
            auto
          </button>
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setView((v) => ({ ...v, pps: Math.max(10, v.pps / 1.5) }))}
            className="px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">−</button>
          <span className="text-[12px] text-muted w-12 text-center tabular-nums">{Math.round(view.pps)} px/s</span>
          <button onClick={() => setView((v) => ({ ...v, pps: Math.min(500, v.pps * 1.5) }))}
            className="px-2 py-1 text-[12px] text-muted hover:text-ink border border-border/35 rounded transition-colors">+</button>
        </div>

        <div className="flex items-center gap-2 ml-auto shrink-0">
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
              click / drag to align · scroll to pan · ctrl+scroll to zoom
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
          <span className="inline-block w-2 h-2 mr-1 rounded-sm" style={{ background: 'rgba(216,106,74,0.8)' }} />
          anchor (phase 0) ·{' '}
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>▏</span> downbeat ·{' '}
          <span style={{ color: 'rgba(255,255,255,0.25)' }}>▏</span> beat
        </span>
      </div>
      </div>
    </div>
  )
}
