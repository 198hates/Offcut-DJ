import { useRef, useEffect, useCallback, useState } from 'react'
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const [pps, setPps] = useState(DEFAULT_PPS)

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

    const ppsScaled = pps * dpr
    const visibleDuration = cw / ppsScaled
    const startTime = currentTime - visibleDuration / 2

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
      const past = t < currentTime

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

    // ── Beat grid tick marks ──────────────────────────────────────────────
    // Markers sit at the top edge. A dark shadow behind the bright fill
    // keeps them readable against any waveform colour underneath.
    if (beatgrid && beatgrid.length > 0) {
      for (const marker of beatgrid) {
        const t = marker.positionMs / 1000
        if (t < startTime - 0.1 || t > startTime + visibleDuration + 0.1) continue
        const x = Math.round(((t - startTime) / visibleDuration) * cw)

        if (marker.isDownbeat) {
          const h = Math.round(22 * dpr)
          const capH = Math.round(3 * dpr)
          // Shadow
          ctx.fillStyle = 'rgba(0,0,0,0.70)'
          ctx.fillRect(x - Math.round(dpr), 0, Math.round(4 * dpr), h)
          // Bright white line
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          ctx.fillRect(x, 0, Math.round(2 * dpr), h)
          // Horizontal top cap to make it look like a ⊤ pin
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          ctx.fillRect(x - Math.round(3 * dpr), 0, Math.round(8 * dpr), capH)
        } else {
          const h = Math.round(10 * dpr)
          // Shadow
          ctx.fillStyle = 'rgba(0,0,0,0.45)'
          ctx.fillRect(x, 0, Math.round(2 * dpr), h)
          // Bright line
          ctx.fillStyle = 'rgba(255,255,255,0.72)'
          ctx.fillRect(x, 0, Math.round(dpr), h)
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

  }, [peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, currentTime, duration, cuePoints, mainCueTime, beatgrid, loopStart, loopEnd, isLooping, pps])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      canvas.width = w * dpr; canvas.height = h * dpr
      sizeRef.current = { w, h, dpr }
      draw()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [draw])

  useEffect(() => { draw() }, [draw])

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration || !sizeRef.current.w) return
    const { w, dpr } = sizeRef.current
    const cw = w * dpr
    const visibleDuration = cw / (pps * dpr)
    const rect = e.currentTarget.getBoundingClientRect()
    const xFrac = (e.clientX - rect.left) / rect.width
    const t = (currentTime - visibleDuration / 2) + xFrac * visibleDuration
    onSeek(Math.max(0, Math.min(duration, t)))
  }, [duration, currentTime, pps, onSeek])

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
      <div className="absolute bottom-1 right-1 flex gap-0.5">
        <button onClick={zoomOut} className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center">−</button>
        <button onClick={zoomIn}  className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center">+</button>
      </div>
    </div>
  )
}
