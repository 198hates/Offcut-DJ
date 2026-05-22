import { useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import type { CuePoint, BeatgridMarker, Beatgrid } from '@shared/types'
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
  analysedBeatgrid?: Beatgrid | null
  onSeek: (time: number) => void
}

export function OverviewWaveform({ peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, duration, currentTime, cuePoints, mainCueTime, beatgrid, analysedBeatgrid, onSeek }: Props): JSX.Element {
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

    // ── Beat grid + confidence strip ─────────────────────────────────────
    const STRIP_H = Math.round(2 * dpr)

    if (analysedBeatgrid && analysedBeatgrid.beats.length > 0 && duration > 0) {
      // Confidence strip — 2px at top
      const SEG_PX = Math.round(16 * dpr)
      const nSegs  = Math.ceil(cw / SEG_PX)
      for (let si = 0; si < nSegs; si++) {
        const tStart = (si * SEG_PX / cw) * duration
        const tEnd   = ((si + 1) * SEG_PX / cw) * duration
        const segBeats = analysedBeatgrid.beats.filter((b) => {
          const t = b.positionMs / 1000; return t >= tStart && t < tEnd
        })
        const conf = segBeats.length > 0
          ? segBeats.reduce((s, b) => s + b.confidence, 0) / segBeats.length
          : 1.0
        ctx.fillStyle = conf > 0.65
          ? `rgba(216,106,74,${0.20 + conf * 0.55})`
          : `rgba(110,101,83,${0.15 + conf * 0.30})`
        ctx.fillRect(si * SEG_PX, 0, SEG_PX + 1, STRIP_H)
      }
      // Downbeat markers — opacity ∝ confidence
      for (const beat of analysedBeatgrid.beats) {
        if (beat.beatInBar !== 0) continue
        const x = Math.round((beat.positionMs / 1000 / duration) * cw)
        ctx.fillStyle = `rgba(216,106,74,${0.25 + beat.confidence * 0.55})`
        ctx.fillRect(x, STRIP_H, 1, ch - STRIP_H)
      }

    } else if (beatgrid && beatgrid.length > 0 && duration > 0) {
      // Legacy — downbeats only, no confidence data
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
  }, [peaks, lowPeaks, midPeaks, highPeaks, waveformStyle, duration, cuePoints, mainCueTime, beatgrid, analysedBeatgrid])

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
