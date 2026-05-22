import { useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import type { CuePoint, BeatgridMarker } from '@shared/types'
import type { WaveformStyle } from '../store/waveformStore'

interface Props {
  peaks: Float32Array | null
  lowPeaks: Float32Array | null
  midPeaks: Float32Array | null
  highPeaks: Float32Array | null
  waveformStyle: WaveformStyle
  duration: number
  currentTime: number
  cuePoints: CuePoint[]
  mainCueTime: number | null
  beatgrid?: BeatgridMarker[]
  onSeek: (time: number) => void
}

export function OverviewWaveform({ peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, duration, currentTime, cuePoints, mainCueTime, beatgrid, onSeek }: Props): JSX.Element {
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const sizeRef        = useRef({ w: 0, h: 0, dpr: 1 })
  const currentTimeRef = useRef(currentTime)

  useLayoutEffect(() => { currentTimeRef.current = currentTime })

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

    const progress = currentTimeRef.current / duration

    // Played region shading
    ctx.fillStyle = 'rgba(0,0,0,0.20)'
    ctx.fillRect(0, 0, progress * cw, ch)

    const use3Band = (waveformStyle === 'three-band' || waveformStyle === 'rgb') && lowPeaks && midPeaks && highPeaks
    const SCALE = 0.92

    if (use3Band && lowPeaks && midPeaks && highPeaks) {
      // Map canvas pixels → band peak buckets for smooth coverage
      for (let x = 0; x < cw; x++) {
        const frac = x / cw
        const past = frac < progress
        const fi  = frac * (lowPeaks.length - 1)
        const bi0 = Math.max(0, Math.floor(fi))
        const bi1 = Math.min(lowPeaks.length - 1, bi0 + 1)
        const a   = fi - bi0
        const bhL = (lowPeaks[bi0]  + a * (lowPeaks[bi1]  - lowPeaks[bi0]))  * mid * SCALE
        const bhM = (midPeaks[bi0]  + a * (midPeaks[bi1]  - midPeaks[bi0]))  * mid * SCALE
        const bhH = (highPeaks[bi0] + a * (highPeaks[bi1] - highPeaks[bi0])) * mid * SCALE

        if (waveformStyle === 'three-band') {
          // Earthen palette — draw low first (back), high last (front/cream peaks)
          ctx.fillStyle = past ? 'rgba(46,38,26,0.42)' : 'rgba(107,90,62,0.98)'   // low: earth-brown
          ctx.fillRect(x, mid - bhL, 2, bhL * 2)
          ctx.fillStyle = past ? 'rgba(82,43,26,0.40)' : 'rgba(194,104,62,0.94)'  // mid: terracotta
          ctx.fillRect(x, mid - bhM, 2, bhM * 2)
          ctx.fillStyle = past ? 'rgba(108,102,90,0.38)' : 'rgba(236,227,204,0.90)' // high: cream peaks
          ctx.fillRect(x, mid - bhH, 2, bhH * 2)
        } else {
          // RGB — low (red) back, mid (green) mid, high (blue) front
          ctx.fillStyle = past ? 'rgba(150,18,18,0.35)' : 'rgba(255,35,35,0.90)'
          ctx.fillRect(x, mid - bhL, 2, bhL * 2)
          ctx.fillStyle = past ? 'rgba(18,115,18,0.35)' : 'rgba(35,215,55,0.90)'
          ctx.fillRect(x, mid - bhM, 2, bhM * 2)
          ctx.fillStyle = past ? 'rgba(18,55,150,0.35)' : 'rgba(35,125,255,0.90)'
          ctx.fillRect(x, mid - bhH, 2, bhH * 2)
        }
      }
    } else if (peaks) {
      // CDJ gradient fallback
      const barW = cw / peaks.length
      // Earthen CDJ gradient: cream edges → terracotta center (no blue)
      const uGrad = ctx.createLinearGradient(0, 0, 0, ch)
      uGrad.addColorStop(0,    'rgba(107,90,62,0.70)')   // earth-brown edge
      uGrad.addColorStop(0.25, 'rgba(236,227,204,0.90)') // cream outer
      uGrad.addColorStop(0.44, 'rgba(214,127,71,1.0)')   // terracotta light
      uGrad.addColorStop(0.50, 'rgba(194,104,62,1.0)')   // terracotta center
      uGrad.addColorStop(0.56, 'rgba(214,127,71,1.0)')
      uGrad.addColorStop(0.75, 'rgba(236,227,204,0.90)')
      uGrad.addColorStop(1,    'rgba(107,90,62,0.70)')
      const pGrad = ctx.createLinearGradient(0, 0, 0, ch)
      pGrad.addColorStop(0,   'rgba(46,38,26,0.40)')
      pGrad.addColorStop(0.5, 'rgba(82,58,30,0.55)')
      pGrad.addColorStop(1,   'rgba(46,38,26,0.40)')
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barW
        const bh = peaks[i] * mid * SCALE
        if (bh < 0.5) continue
        ctx.fillStyle = (i / peaks.length) < progress ? pGrad : uGrad
        ctx.fillRect(x, mid - bh, Math.max(1, barW), bh * 2)
      }
    }

    // Beat grid — downbeats only in overview (beat density too high to show all)
    if (beatgrid && beatgrid.length > 0 && duration > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      for (const marker of beatgrid) {
        if (!marker.isDownbeat) continue
        const x = Math.round((marker.positionMs / 1000 / duration) * cw)
        ctx.fillRect(x, 0, 1, ch)
      }
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
  }, [peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, duration, cuePoints, mainCueTime, beatgrid])

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
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let raf: number
    const loop = () => { draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw])

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - rect.left) / rect.width) * duration)
  }, [duration, onSeek])

  return (
    <canvas
      ref={canvasRef}
      className="w-full block cursor-pointer"
      style={{ height: 26 }}
      onClick={handleClick}
    />
  )
}
