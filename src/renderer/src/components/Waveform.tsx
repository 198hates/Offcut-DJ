import { useRef, useEffect, useCallback, useState } from 'react'
import type { CuePoint } from '@shared/types'

interface Props {
  peaks: Float32Array | null          // 8000-bucket detail peaks
  duration: number
  currentTime: number
  cuePoints: CuePoint[]
  mainCueTime: number | null
  onSeek: (time: number) => void
  isLoading?: boolean
}

// Default zoom: show ~8 seconds of audio
const DEFAULT_PPS = 100 // pixels per second

export function Waveform({ peaks, duration, currentTime, cuePoints, mainCueTime, onSeek, isLoading }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const [pps, setPps] = useState(DEFAULT_PPS) // pixels per second (zoom)

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

    // ── Center line ──────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(0, mid - 0.5, cw, 1)

    if (!peaks || duration === 0) return

    const ppsScaled = pps * dpr
    const visibleDuration = cw / ppsScaled
    const startTime = currentTime - visibleDuration / 2

    // ── Build two gradient fill styles ───────────────────────────────────
    // Unplayed: Rekordbox-style cyan/blue gradient, bright white at center
    const uGrad = ctx.createLinearGradient(0, 0, 0, ch)
    uGrad.addColorStop(0,    'rgba(0,120,200,0.55)')
    uGrad.addColorStop(0.25, 'rgba(0,180,255,0.85)')
    uGrad.addColorStop(0.45, 'rgba(80,230,255,1.0)')
    uGrad.addColorStop(0.5,  'rgba(255,255,255,1.0)')  // center line — white
    uGrad.addColorStop(0.55, 'rgba(80,230,255,1.0)')
    uGrad.addColorStop(0.75, 'rgba(0,180,255,0.85)')
    uGrad.addColorStop(1,    'rgba(0,120,200,0.55)')

    // Played: desaturated slate-gray, same shape
    const pGrad = ctx.createLinearGradient(0, 0, 0, ch)
    pGrad.addColorStop(0,   'rgba(50,70,90,0.5)')
    pGrad.addColorStop(0.4, 'rgba(90,115,135,0.75)')
    pGrad.addColorStop(0.5, 'rgba(140,160,175,0.85)')
    pGrad.addColorStop(0.6, 'rgba(90,115,135,0.75)')
    pGrad.addColorStop(1,   'rgba(50,70,90,0.5)')

    // ── Draw bars pixel-column by pixel-column ───────────────────────────
    // No gap between bars — solid fill like Rekordbox
    const BAR_W = Math.max(2, Math.round(2 * dpr))
    const STEP  = BAR_W

    for (let x = 0; x < cw; x += STEP) {
      const t = startTime + (x / cw) * visibleDuration
      if (t < 0 || t > duration) continue
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.round((t / duration) * peaks.length)))
      const bh = peaks[idx] * mid * 0.88
      if (bh < 0.5) continue

      ctx.fillStyle = t < currentTime ? pGrad : uGrad
      ctx.fillRect(x, mid - bh, BAR_W, bh * 2)
    }

    // ── Cue markers ──────────────────────────────────────────────────────
    for (const cue of cuePoints) {
      const t = cue.positionMs / 1000
      if (t < startTime || t > startTime + visibleDuration) continue
      const x = ((t - startTime) / visibleDuration) * cw
      const color = cue.color || '#ff8c00'
      ctx.fillStyle = color
      ctx.fillRect(x - 1, 0, 2, ch)
      // Triangle at top
      ctx.beginPath()
      ctx.moveTo(x - 5 * dpr, 0)
      ctx.lineTo(x + 5 * dpr, 0)
      ctx.lineTo(x, 8 * dpr)
      ctx.closePath()
      ctx.fill()
      // Label
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
        ctx.moveTo(x - 5 * dpr, ch)
        ctx.lineTo(x + 5 * dpr, ch)
        ctx.lineTo(x, ch - 8 * dpr)
        ctx.closePath()
        ctx.fill()
      }
    }

    // ── Center baseline (1px) ────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(0, mid - 0.5, cw, 1)

    // ── Playhead (center) ────────────────────────────────────────────────
    const cx = cw / 2
    // Glow halo
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fillRect(cx - 6 * dpr, 0, 12 * dpr, ch)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.fillRect(cx - 3 * dpr, 0, 6 * dpr, ch)
    // Sharp 2px line
    ctx.fillStyle = 'rgba(255,255,255,0.97)'
    ctx.fillRect(cx - dpr, 0, 2 * dpr, ch)

  }, [peaks, currentTime, duration, cuePoints, mainCueTime, pps])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
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
    const ppsScaled = pps * dpr
    const cw = w * dpr
    const visibleDuration = cw / ppsScaled
    const rect = e.currentTarget.getBoundingClientRect()
    const xFrac = (e.clientX - rect.left) / rect.width
    const t = (currentTime - visibleDuration / 2) + xFrac * visibleDuration
    onSeek(Math.max(0, Math.min(duration, t)))
  }, [duration, currentTime, pps, onSeek])

  const zoomIn  = () => setPps((p) => Math.min(p * 2, 1600))
  const zoomOut = () => setPps((p) => Math.max(p / 2, 25))

  return (
    <div className="relative flex-1 min-w-0 bg-black/40 rounded overflow-hidden flex flex-col">
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
      <canvas
        ref={canvasRef}
        className="flex-1 w-full cursor-crosshair block"
        onClick={handleClick}
      />
      {/* Zoom controls */}
      <div className="absolute bottom-1 right-1 flex gap-0.5">
        <button onClick={zoomOut} className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center leading-none" title="Zoom out (-)">−</button>
        <button onClick={zoomIn}  className="w-5 h-5 rounded bg-black/50 text-white/50 hover:text-white text-xs flex items-center justify-center leading-none" title="Zoom in (+)">+</button>
      </div>
    </div>
  )
}
