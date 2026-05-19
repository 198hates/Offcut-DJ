import { useRef, useEffect, useCallback } from 'react'
import type { CuePoint } from '@shared/types'

interface Props {
  peaks: Float32Array | null   // 1000-bucket overview peaks
  duration: number
  currentTime: number
  cuePoints: CuePoint[]
  mainCueTime: number | null
  onSeek: (time: number) => void
}

export function OverviewWaveform({ peaks, duration, currentTime, cuePoints, mainCueTime, onSeek }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })

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

    const progress = currentTime / duration

    // Played region shading
    ctx.fillStyle = 'rgba(0,160,255,0.08)'
    ctx.fillRect(0, 0, progress * cw, ch)

    // Background gradient for unplayed region
    const bgGrad = ctx.createLinearGradient(0, 0, 0, ch)
    bgGrad.addColorStop(0,   'rgba(0,80,160,0.0)')
    bgGrad.addColorStop(0.5, 'rgba(0,140,220,0.12)')
    bgGrad.addColorStop(1,   'rgba(0,80,160,0.0)')
    ctx.fillStyle = bgGrad
    ctx.fillRect(progress * cw, 0, cw, ch)

    // Bars
    const barW = cw / peaks.length
    const uGrad = ctx.createLinearGradient(0, 0, 0, ch)
    uGrad.addColorStop(0,   'rgba(0,140,220,0.5)')
    uGrad.addColorStop(0.5, 'rgba(80,210,255,0.95)')
    uGrad.addColorStop(1,   'rgba(0,140,220,0.5)')
    const pGrad = ctx.createLinearGradient(0, 0, 0, ch)
    pGrad.addColorStop(0,   'rgba(50,80,110,0.4)')
    pGrad.addColorStop(0.5, 'rgba(90,130,160,0.7)')
    pGrad.addColorStop(1,   'rgba(50,80,110,0.4)')

    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW
      const bh = peaks[i] * mid * 0.92
      if (bh < 0.5) continue
      ctx.fillStyle = (i / peaks.length) < progress ? pGrad : uGrad
      ctx.fillRect(x, mid - bh, Math.max(1, barW), bh * 2)
    }

    // Cue markers
    for (const cue of cuePoints) {
      const x = (cue.positionMs / 1000 / duration) * cw
      ctx.fillStyle = cue.color || '#ff8c00'
      ctx.fillRect(x - 1, 0, 1.5, ch)
    }

    // Main CUE
    if (mainCueTime !== null) {
      const x = (mainCueTime / duration) * cw
      ctx.fillStyle = '#00ff88'
      ctx.fillRect(x - 1, 0, 1.5, ch)
    }

    // Playhead
    const px = progress * cw
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fillRect(px - 1, 0, 2, ch)

    // Viewport indicator: show visible window
    // (We don't have zoom info here, just show a subtle region marker)
  }, [peaks, currentTime, duration, cuePoints, mainCueTime])

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
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - rect.left) / rect.width) * duration)
  }, [duration, onSeek])

  return (
    <canvas
      ref={canvasRef}
      className="w-full block cursor-pointer"
      style={{ height: 40 }}
      onClick={handleClick}
    />
  )
}
