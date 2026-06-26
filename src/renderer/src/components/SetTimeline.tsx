import { useRef, useEffect, useCallback } from 'react'
import { useThemeStore } from '../store/themeStore'
import type { Track } from '@shared/types'
import { keyBlipColor } from './CamelotWheel'
import { formatHoursMinutes } from '../lib/format'

interface Props {
  tracks: Track[]       // ordered playlist tracks
  onSeekToTrack?: (trackId: string) => void
}

export function SetTimeline({ tracks, onSeekToTrack }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { theme } = useThemeStore()
  const isDark = theme === 'dark'

  const tracksWithBpm = tracks.filter((t) => t.bpm != null && t.durationSeconds != null)
  const totalDuration = tracksWithBpm.reduce((s, t) => s + (t.durationSeconds ?? 0), 0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || tracksWithBpm.length < 2) return
    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, W, H)

    const accent  = '#E0A23C'  // amber energy arc (Field Unit) — same in both themes
    const grid    = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(20,17,14,0.07)'
    const lblClr  = isDark ? '#6A6457' : '#8A8474'

    const bpmValues = tracksWithBpm.map((t) => t.bpm!)
    const bpmMin = Math.min(...bpmValues) - 2
    const bpmMax = Math.max(...bpmValues) + 2
    const padT = 8, padB = 16, padX = 4
    const chartH = H - padT - padB

    // Grid lines
    const step = bpmMax - bpmMin > 10 ? 4 : 2
    for (let b = Math.ceil(bpmMin / step) * step; b <= bpmMax; b += step) {
      const y = padT + chartH - ((b - bpmMin) / (bpmMax - bpmMin)) * chartH
      ctx.strokeStyle = grid
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(W - padX, y); ctx.stroke()
      ctx.fillStyle = lblClr
      ctx.font = `400 8px 'JetBrains Mono', monospace`
      ctx.textAlign = 'right'
      ctx.fillText(String(b), W - padX + 2, y + 3)
    }

    // Compute x positions from cumulative durations
    let cum = 0
    const pts: { x: number; y: number; track: Track }[] = []
    for (const t of tracksWithBpm) {
      const mid = cum + (t.durationSeconds ?? 0) / 2
      const x = padX + (mid / totalDuration) * (W - padX * 2)
      const y = padT + chartH - ((t.bpm! - bpmMin) / (bpmMax - bpmMin)) * chartH
      pts.push({ x, y, track: t })
      cum += t.durationSeconds ?? 0
    }

    // Area fill
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.lineTo(pts[pts.length - 1].x, H - padB)
    ctx.lineTo(pts[0].x, H - padB)
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB)
    grad.addColorStop(0, `${accent}22`)
    grad.addColorStop(1, `${accent}06`)
    ctx.fillStyle = grad
    ctx.fill()

    // Line
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.strokeStyle = accent
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Dots
    for (const { x, y, track } of pts) {
      const color = keyBlipColor(track.key)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = isDark ? '#14110D' : '#FBF7EC'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // Time axis
    ctx.fillStyle = lblClr
    ctx.font = `400 8px 'JetBrains Mono', monospace`
    ctx.textAlign = 'left'
    const ticks = [0, 0.25, 0.5, 0.75, 1]
    for (const t of ticks) {
      const mins = Math.floor(t * totalDuration / 60)
      const x = padX + t * (W - padX * 2)
      ctx.fillText(`${String(mins).padStart(2, '0')}:00`, x, H)
    }
  }, [tracksWithBpm, totalDuration, isDark])

  useEffect(() => {
    draw()
  }, [draw])

  // Track strip
  let cum = 0
  const strips = tracksWithBpm.map((t) => {
    const w = ((t.durationSeconds ?? 0) / totalDuration) * 100
    const color = keyBlipColor(t.key)
    const left = (cum / totalDuration) * 100
    cum += t.durationSeconds ?? 0
    return { id: t.id, left, w, color }
  })

  const durationStr = formatHoursMinutes(totalDuration)
  const avgBpm = tracksWithBpm.length
    ? (tracksWithBpm.reduce((s, t) => s + t.bpm!, 0) / tracksWithBpm.length).toFixed(1)
    : null

  return (
    <div className="border-t border-border/30 bg-chassis-soft shrink-0 px-3 pt-2 pb-2 space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-mono uppercase tracking-[0.18em] text-muted">
          <span className="text-accent font-bold mr-1">03</span>set timeline
        </span>
        <span className="text-[12px] font-mono text-muted tabular-nums">
          {tracks.length} trks
          {avgBpm && <> · avg {avgBpm} bpm</>}
          {totalDuration > 0 && <> · {durationStr}</>}
        </span>
      </div>

      {tracksWithBpm.length < 2 ? (
        <p className="text-[12px] font-mono text-muted/60 italic py-2">
          Add tracks with BPM data to see the curve
        </p>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            className="w-full rounded"
            style={{ height: 72, display: 'block' }}
          />
          {/* Track strip */}
          <div className="relative h-4 rounded overflow-hidden border border-border/30">
            {strips.map(({ id, left, w, color }) => (
              <div
                key={id}
                className="absolute top-0 bottom-0 cursor-pointer hover:brightness-110 transition-all border-r border-chassis/20"
                style={{ left: `${left}%`, width: `${w}%`, background: color, opacity: 0.85 }}
                onClick={() => onSeekToTrack?.(id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
