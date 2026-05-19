import { useRef, useEffect, useCallback } from 'react'
import type { CuePoint } from '@shared/types'

interface Props {
  peaks: Float32Array | null
  duration: number
  currentTime: number
  cuePoints: CuePoint[]
  onSeek: (time: number) => void
  isLoading?: boolean
}

const CUE_COLORS: Record<string, string> = {
  hotcue: '#6366f1',
  memory: '#f59e0b',
  loop: '#10b981',
}

export function Waveform({ peaks, duration, currentTime, cuePoints, onSeek, isLoading }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { w, h, dpr } = sizeRef.current
    if (w === 0 || h === 0) return

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w * dpr, h * dpr)

    if (!peaks || duration === 0) return

    const cw = w * dpr
    const ch = h * dpr
    const mid = ch / 2
    const progress = duration > 0 ? currentTime / duration : 0
    const barW = cw / peaks.length

    // Waveform bars
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW
      const bh = peaks[i] * mid * 0.85
      const played = i / peaks.length < progress
      ctx.fillStyle = played ? '#6366f1' : '#3b3b5c'
      ctx.fillRect(x, mid - bh, Math.max(1, barW - 0.5), bh * 2)
    }

    // Cue markers
    for (const cue of cuePoints) {
      const x = (cue.positionMs / 1000 / duration) * cw
      const color = cue.color || CUE_COLORS[cue.type] || '#ff8c00'
      ctx.fillStyle = color
      ctx.fillRect(x - 1, 0, 2, ch)
      ctx.beginPath()
      ctx.moveTo(x - 5, 0)
      ctx.lineTo(x + 5, 0)
      ctx.lineTo(x, 8)
      ctx.closePath()
      ctx.fill()
    }

    // Playhead
    const px = progress * cw
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.fillRect(px - 1, 0, 2, ch)
  }, [peaks, currentTime, duration, cuePoints])

  // Resize observer — updates canvas pixel dimensions and redraws
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

  // Redraw on data/time change
  useEffect(() => { draw() }, [draw])

  const handlePointer = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - rect.left) / rect.width) * duration)
  }, [duration, onSeek])

  return (
    <div className="relative flex-1 min-w-0 bg-black/30 rounded overflow-hidden" style={{ height: 56 }}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/30 text-xs pointer-events-none">
          Analysing…
        </div>
      )}
      {!peaks && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/20 text-xs pointer-events-none">
          No track loaded
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-pointer block"
        onClick={handlePointer}
      />
    </div>
  )
}
