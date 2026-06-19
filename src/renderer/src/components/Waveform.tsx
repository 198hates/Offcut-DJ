import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react'
import type { CuePoint, BeatgridMarker } from '@shared/types'

import type { WaveformStyle } from '../store/waveformStore'

interface Props {
  peaks: Float32Array | null
  detailPeaks?: Float32Array | null
  lowPeaks: Float32Array | null
  midPeaks: Float32Array | null
  highPeaks: Float32Array | null
  waveformStyle: WaveformStyle
  duration: number
  currentTime: number
  cuePoints: CuePoint[]
  mainCueTime: number | null
  beatgrid?: BeatgridMarker[]
  loopStart?: number | null
  loopEnd?: number | null
  isLooping?: boolean
  onSeek: (time: number) => void
  isLoading?: boolean
}

const DEFAULT_PPS = 100

export function Waveform({
  peaks, lowPeaks, midPeaks, highPeaks, waveformStyle,
  duration, currentTime, cuePoints, mainCueTime, beatgrid,
  loopStart, loopEnd, isLooping,
  onSeek, isLoading
}: Props): JSX.Element {
  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const sizeRef         = useRef({ w: 0, h: 0, dpr: 1 })
  const currentTimeRef  = useRef(currentTime)
  const [pps, setPps]   = useState(DEFAULT_PPS)

  // Keep time ref in sync with prop (no re-render needed)
  useLayoutEffect(() => { currentTimeRef.current = currentTime })

  // Initialise canvas backing-store dimensions synchronously before first RAF frame
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w   = canvas.offsetWidth
    const h   = canvas.offsetHeight
    if (w === 0 || h === 0) return
    canvas.width  = w * dpr
    canvas.height = h * dpr
    sizeRef.current = { w, h, dpr }
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { w, h, dpr } = sizeRef.current
    if (w === 0 || h === 0) return

    const ctx = canvas.getContext('2d')!
    const cw = w * dpr
    const ch = h * dpr
    const mid = ch / 2
    ctx.clearRect(0, 0, cw, ch)

    if (!peaks || duration === 0) return

    const ct = currentTimeRef.current
    const ppsScaled = pps * dpr
    const visibleDuration = cw / ppsScaled
    const startTime = ct - visibleDuration / 2

    // ── CDJ-3000 spectral gradient ────────────────────────────────────────
    // Tips = cyan/blue (treble transients), center = orange-red (bass energy)
    const uGrad = ctx.createLinearGradient(0, 0, 0, ch)
    uGrad.addColorStop(0,    'rgba(20,190,255,0.75)')   // tip: cyan (treble)
    uGrad.addColorStop(0.18, 'rgba(40,215,255,1.0)')    // upper: bright cyan
    uGrad.addColorStop(0.36, 'rgba(255,255,255,1.0)')   // white (upper mids)
    uGrad.addColorStop(0.46, 'rgba(255,190,20,1.0)')    // yellow-orange (mid-bass)
    uGrad.addColorStop(0.50, 'rgba(255,75,10,1.0)')     // center: hot orange-red (bass)
    uGrad.addColorStop(0.54, 'rgba(255,190,20,1.0)')    // mirror
    uGrad.addColorStop(0.64, 'rgba(255,255,255,1.0)')   // mirror white
    uGrad.addColorStop(0.82, 'rgba(40,215,255,1.0)')    // mirror cyan
    uGrad.addColorStop(1,    'rgba(20,190,255,0.75)')   // tip

    // Played region: same structure, dimmed and desaturated
    const pGrad = ctx.createLinearGradient(0, 0, 0, ch)
    pGrad.addColorStop(0,    'rgba(0,90,130,0.45)')
    pGrad.addColorStop(0.20, 'rgba(20,110,160,0.60)')
    pGrad.addColorStop(0.38, 'rgba(80,100,130,0.65)')
    pGrad.addColorStop(0.47, 'rgba(120,80,40,0.60)')
    pGrad.addColorStop(0.50, 'rgba(100,50,20,0.60)')
    pGrad.addColorStop(0.53, 'rgba(120,80,40,0.60)')
    pGrad.addColorStop(0.62, 'rgba(80,100,130,0.65)')
    pGrad.addColorStop(0.80, 'rgba(20,110,160,0.60)')
    pGrad.addColorStop(1,    'rgba(0,90,130,0.45)')

    // ── Loop region highlight ─────────────────────────────────────────────
    if (loopStart != null && loopEnd != null && loopEnd > loopStart) {
      const lx1 = ((loopStart - startTime) / visibleDuration) * cw
      const lx2 = ((loopEnd - startTime) / visibleDuration) * cw
      ctx.fillStyle = isLooping ? 'rgba(184,74,43,0.18)' : 'rgba(184,74,43,0.08)'
      ctx.fillRect(lx1, 0, lx2 - lx1, ch)
      // Loop bracket lines
      ctx.fillStyle = isLooping ? 'rgba(184,74,43,0.90)' : 'rgba(184,74,43,0.50)'
      ctx.fillRect(lx1, 0, 2, ch)
      ctx.fillRect(lx2 - 2, 0, 2, ch)
      // Top/bottom horizontal bars
      ctx.fillRect(lx1, 0, 8, 2)
      ctx.fillRect(lx1, ch - 2, 8, 2)
      ctx.fillRect(lx2 - 8, 0, 8, 2)
      ctx.fillRect(lx2 - 8, ch - 2, 8, 2)
    }

    // ── Waveform bars ────────────────────────────────────────────────────
    // 1px logical bars (2px on Retina) — tight enough to look solid
    const BAR_W = Math.max(1, Math.round(dpr))
    const BW1 = BAR_W + 1   // +1 prevents sub-pixel gaps at Retina boundaries
    const use3Band = (waveformStyle === 'three-band' || waveformStyle === 'rgb') && lowPeaks && midPeaks && highPeaks
    const SCALE = 0.92

    for (let x = 0; x < cw; x += BAR_W) {
      const t = startTime + (x / cw) * visibleDuration
      if (t < 0 || t > duration) continue
      const past = t < ct

      if (use3Band && lowPeaks && midPeaks && highPeaks) {
        // Linear interpolation between adjacent buckets for smooth look
        const fi  = (t / duration) * (lowPeaks.length - 1)
        const bi0 = Math.max(0, Math.floor(fi))
        const bi1 = Math.min(lowPeaks.length - 1, bi0 + 1)
        const alpha = fi - bi0
        const bhL = (lowPeaks[bi0]  + alpha * (lowPeaks[bi1]  - lowPeaks[bi0]))  * mid * SCALE
        const bhM = (midPeaks[bi0]  + alpha * (midPeaks[bi1]  - midPeaks[bi0]))  * mid * SCALE
        const bhH = (highPeaks[bi0] + alpha * (highPeaks[bi1] - highPeaks[bi0])) * mid * SCALE

        if (waveformStyle === 'three-band') {
          ctx.fillStyle = past ? 'rgba(15,70,145,0.38)' : 'rgba(25,135,255,0.90)'
          ctx.fillRect(x, mid - bhH, BW1, bhH * 2)
          ctx.fillStyle = past ? 'rgba(100,52,12,0.40)' : 'rgba(215,118,28,0.94)'
          ctx.fillRect(x, mid - bhM, BW1, bhM * 2)
          ctx.fillStyle = past ? 'rgba(130,115,85,0.42)' : 'rgba(248,232,195,0.98)'
          ctx.fillRect(x, mid - bhL, BW1, bhL * 2)
        } else {
          // RGB: red=bass, green=mid, blue=high
          ctx.fillStyle = past ? 'rgba(150,18,18,0.38)' : 'rgba(255,35,35,0.92)'
          ctx.fillRect(x, mid - bhL, BW1, bhL * 2)
          ctx.fillStyle = past ? 'rgba(18,115,18,0.38)' : 'rgba(35,215,55,0.92)'
          ctx.fillRect(x, mid - bhM, BW1, bhM * 2)
          ctx.fillStyle = past ? 'rgba(18,55,150,0.38)' : 'rgba(35,125,255,0.92)'
          ctx.fillRect(x, mid - bhH, BW1, bhH * 2)
        }
      } else {
        const idx = Math.min(peaks!.length - 1, Math.max(0, Math.round((t / duration) * peaks!.length)))
        const bh = peaks![idx] * mid * 0.88
        if (bh < 0.5) continue
        ctx.fillStyle = past ? pGrad : uGrad
        ctx.fillRect(x, mid - bh, BW1, bh * 2)
      }
    }

    // ── Beat grid — Rekordbox style ───────────────────────────────────────
    // Full-height hairlines: subtle for off-beats, brighter for bar markers.
    // Bar numbers printed in small mono text just inside the top edge.
    if (beatgrid && beatgrid.length > 0) {
      // Pre-count bar numbers so they're correct even when scrolled mid-track
      let barCount = 1
      const barNums = new Map<number, number>()
      for (const m of beatgrid) {
        if (m.isDownbeat) barNums.set(m.positionMs, barCount++)
      }

      const lw = Math.round(dpr)  // 1 logical pixel

      // Off-beat lines first (drawn under bar lines)
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      for (const marker of beatgrid) {
        if (marker.isDownbeat) continue
        const t = marker.positionMs / 1000
        if (t < startTime - 0.05 || t > startTime + visibleDuration + 0.05) continue
        const x = Math.round(((t - startTime) / visibleDuration) * cw)
        ctx.fillRect(x, 0, lw, ch)
      }

      // Bar lines + numbers on top
      ctx.font = `${Math.round(7.5 * dpr)}px 'JetBrains Mono', monospace`
      ctx.textAlign = 'center'
      for (const marker of beatgrid) {
        if (!marker.isDownbeat) continue
        const t = marker.positionMs / 1000
        if (t < startTime - 0.05 || t > startTime + visibleDuration + 0.05) continue
        const x = Math.round(((t - startTime) / visibleDuration) * cw)

        // Bar line — full height
        ctx.fillStyle = 'rgba(255,255,255,0.52)'
        ctx.fillRect(x, 0, lw, ch)

        // Bar number
        const bn = barNums.get(marker.positionMs)
        if (bn !== undefined) {
          ctx.fillStyle = 'rgba(255,255,255,0.60)'
          ctx.fillText(String(bn), x, Math.round(8.5 * dpr))
        }
      }
    }

    // ── Cue markers ──────────────────────────────────────────────────────
    for (const cue of cuePoints) {
      const t = cue.positionMs / 1000
      if (t < startTime || t > startTime + visibleDuration) continue
      const x = ((t - startTime) / visibleDuration) * cw
      const color = cue.color || '#ff8c00'
      ctx.fillStyle = color
      ctx.fillRect(x - 1, 0, 2, ch)
      ctx.beginPath()
      ctx.moveTo(x - 5 * dpr, 0); ctx.lineTo(x + 5 * dpr, 0); ctx.lineTo(x, 8 * dpr)
      ctx.closePath(); ctx.fill()
      if (cue.label) {
        ctx.font = `bold ${10 * dpr}px monospace`
        ctx.fillStyle = color
        ctx.fillText(cue.label, x + 4 * dpr, 14 * dpr)
      }
    }

    // ── Main CUE marker ──────────────────────────────────────────────────
    if (mainCueTime !== null) {
      const t = mainCueTime
      if (t >= startTime && t <= startTime + visibleDuration) {
        const x = ((t - startTime) / visibleDuration) * cw
        ctx.fillStyle = '#00ff88'
        ctx.fillRect(x - 1, 0, 2, ch)
        ctx.beginPath()
        ctx.moveTo(x - 5 * dpr, ch); ctx.lineTo(x + 5 * dpr, ch); ctx.lineTo(x, ch - 8 * dpr)
        ctx.closePath(); ctx.fill()
      }
    }

    // ── Center baseline ───────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(0, mid - 0.5, cw, 1)

    // ── Playhead ──────────────────────────────────────────────────────────
    const cx = cw / 2
    ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(cx - 6 * dpr, 0, 12 * dpr, ch)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(cx - 3 * dpr, 0, 6 * dpr, ch)
    ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.fillRect(cx - dpr, 0, 2 * dpr, ch)

  }, [peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, duration, cuePoints, mainCueTime, beatgrid, loopStart, loopEnd, isLooping, pps])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      canvas.width = w * dpr; canvas.height = h * dpr
      sizeRef.current = { w, h, dpr }
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // RAF loop — draws every frame using the latest time from the ref,
  // bypassing React's render cycle for smooth 60fps playback and scrubbing.
  useEffect(() => {
    let raf: number
    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration || !sizeRef.current.w) return
    const { w, dpr } = sizeRef.current
    const cw = w * dpr
    const visibleDuration = cw / (pps * dpr)
    const rect = e.currentTarget.getBoundingClientRect()
    const xFrac = (e.clientX - rect.left) / rect.width
    const t = (currentTimeRef.current - visibleDuration / 2) + xFrac * visibleDuration
    onSeek(Math.max(0, Math.min(duration, t)))
  }, [duration, pps, onSeek])

  const zoomIn  = () => setPps((p) => Math.min(p * 2, 1600))
  const zoomOut = () => setPps((p) => Math.max(p / 2, 25))

  return (
    <div className="relative flex-1 min-w-0 bg-black/40 rounded overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/30 text-xs pointer-events-none z-10">
          Analysing…
        </div>
      )}
      {!peaks && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/15 text-xs pointer-events-none">
          Load a track
        </div>
      )}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full cursor-crosshair block" onClick={handleClick} />
      <div className="absolute bottom-1 right-1 flex gap-1">
        <button onClick={zoomOut} title="Zoom out" className="w-7 h-7 rounded bg-black/70 border border-white/15 text-white/80 hover:text-white hover:border-white/40 text-sm flex items-center justify-center transition-colors">−</button>
        <button onClick={zoomIn}  title="Zoom in"  className="w-7 h-7 rounded bg-black/70 border border-white/15 text-white/80 hover:text-white hover:border-white/40 text-sm flex items-center justify-center transition-colors">+</button>
      </div>
    </div>
  )
}
