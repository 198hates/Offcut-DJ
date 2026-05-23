/**
 * GraphView — force-directed compatibility graph for Set Builder.
 *
 * Anchored nodes  = tracks in the active chapter (fixed positions, horizontal)
 * Candidate ring  = top-30 library tracks by compatibility to the chapter centroid
 *                   (floating, physics-settled around their most compatible anchor)
 *
 * Edges between anchors are coloured by match type:
 *   green  = harmonic (Camelot adjacent)
 *   amber  = BPM proximity (< 5 BPM)
 *   steel  = mood proximity (Δ < 0.3)
 *   muted  = general compatibility
 *
 * Physics: simple spring-repulsion (Coulomb + Hooke + damping).
 * Settles in ~20 ticks after any layout change, then stops (no idle animation).
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { compatibilityScore, harmonicScore } from '../../lib/compatibility'
import { keyBlipColor } from '../../components/CamelotWheel'
import { useArtwork } from '../../hooks/useArtwork'
import { usePreview } from '../../hooks/usePreview'
import type { Track, Playlist } from '@shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the duration of 8 bars in seconds given a BPM. */
function eightBarsSec(bpm: number | null): number {
  if (!bpm || bpm < 40) return 15
  return (8 * 4 * 60) / bpm   // 8 bars × 4 beats / bpm
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChapterProfile {
  bpmAvg: number | null
  energyAvg: number | null
  moodAvg: number | null
  keyCluster: string | null
}

export interface GraphViewProps {
  chapters: Playlist[]
  chapterTracks: Map<string, Track[]>
  profiles: Map<string, ChapterProfile>
  activeChapterId: string | null
  onAddTracks: (chapterId: string, trackIds: string[]) => Promise<void>
  onLoadA: (t: Track) => void
}

interface GNode {
  id: string
  track: Track
  x: number; y: number
  vx: number; vy: number
  isAnchor: boolean
  score: number       // vs chapter centroid (candidates); 1.0 for anchors
  parentIdx: number   // which anchor index is closest (candidates)
  orbitAngle: number  // radians
  orbitR: number      // target orbit radius in px
  dismissed: boolean
}

// ── Physics constants ─────────────────────────────────────────────────────────

const REPULSION  = 1800   // Coulomb repulsion constant (px² × mass)
const SPRING_K   = 0.06   // spring stiffness toward orbit target
const DAMPING    = 0.82   // per-tick velocity multiplier
const MIN_DIST   = 22     // px — minimum repulsion distance (node radius)
const SETTLE_V   = 0.3    // px/tick — below this kinetic energy → stop physics
const ORBIT_BASE = 110    // base orbit radius for a candidate with score=0

// ── Match type edge colour ─────────────────────────────────────────────────────

function edgeColor(a: Track, b: Track): { color: string; width: number } {
  const h = harmonicScore(a.key, b.key)
  const bpmClose = a.bpm != null && b.bpm != null && Math.abs(a.bpm - b.bpm) < 5
  const moodClose = a.mood != null && b.mood != null && Math.abs(a.mood - b.mood) < 0.3
  const score = compatibilityScore(a, b)
  const w = Math.max(0.5, score * 3)
  if (h > 0.75) return { color: '#4A9B6F', width: w }      // harmonic — green
  if (bpmClose)  return { color: '#C9A02C', width: w }      // BPM — amber
  if (moodClose) return { color: '#4E7090', width: w }      // mood — steel
  return { color: 'rgba(110,101,83,0.45)', width: w * 0.6 } // general — muted
}

// ── GraphView ─────────────────────────────────────────────────────────────────

export function GraphView({ chapterTracks, profiles, activeChapterId, onAddTracks, onLoadA }: GraphViewProps): JSX.Element {
  const { tracks: allTracks } = useLibraryStore()
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const nodesRef     = useRef<GNode[]>([])
  const rafRef       = useRef<number | null>(null)
  const ticksRef     = useRef(0)
  const [hoverNode,  setHoverNode]  = useState<GNode | null>(null)
  const [hoverPos,   setHoverPos]   = useState<{ x: number; y: number } | null>(null)
  const [dismissed,  setDismissed]  = useState<Set<string>>(new Set())
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 500 })

  // ── Audio preview on hover ───────────────────────────────────────────────────
  const { previewId, preview: startPreview, stop: stopPreview } = usePreview()
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Album art for the currently hovered node
  const hoverArtwork = useArtwork(hoverNode?.track.filePath)

  // When hoverNode changes, schedule an 8-bar preview after 600ms.
  // Candidates only — clicking anchors loads them on deck.
  useEffect(() => {
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
    if (!hoverNode || hoverNode.isAnchor) { stopPreview(); return }
    previewTimerRef.current = setTimeout(() => {
      startPreview(hoverNode.track, eightBarsSec(hoverNode.track.bpm))
    }, 600)
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverNode?.id])

  const anchorTracks  = activeChapterId ? (chapterTracks.get(activeChapterId) ?? []) : []

  // ── Candidate pool ──────────────────────────────────────────────────────────
  const centroid = useMemo(() => {
    if (!activeChapterId) return null
    const p = profiles.get(activeChapterId)
    if (!p) return null
    return { bpm: p.bpmAvg, energy: p.energyAvg, key: p.keyCluster, mood: p.moodAvg } as Track
  }, [activeChapterId, profiles])

  const inChapterIds = useMemo(() => {
    const s = new Set<string>()
    for (const tracks of chapterTracks.values()) tracks.forEach((t) => s.add(t.id))
    return s
  }, [chapterTracks])

  const candidates = useMemo(() => {
    if (!centroid || anchorTracks.length === 0) return []
    return allTracks
      .filter((t) => !inChapterIds.has(t.id) && !dismissed.has(t.id))
      .map((t) => ({ track: t, score: compatibilityScore(centroid, t) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
  }, [centroid, anchorTracks, allTracks, inChapterIds, dismissed])

  // ── Build / re-build node list ──────────────────────────────────────────────
  const buildNodes = useCallback(() => {
    const { w, h } = canvasSize
    const n = anchorTracks.length
    const spacing = n > 1 ? Math.min(160, (w * 0.7) / (n - 1)) : 0
    const startX = w / 2 - spacing * (n - 1) / 2
    const centerY = h / 2

    // Anchors — fixed horizontal layout
    const anchors: GNode[] = anchorTracks.map((t, i) => ({
      id: t.id, track: t,
      x: startX + i * spacing, y: centerY,
      vx: 0, vy: 0,
      isAnchor: true, score: 1.0,
      parentIdx: i, orbitAngle: 0, orbitR: 0,
      dismissed: false,
    }))

    // Count how many candidates map to each anchor (for angle distribution)
    const anchorCount: number[] = anchorTracks.map(() => 0)

    const cands: GNode[] = candidates.map(({ track, score }) => {
      // Find most compatible anchor
      let bestScore = -1; let parentIdx = 0
      anchorTracks.forEach((a, i) => {
        const s = compatibilityScore(a, track)
        if (s > bestScore) { bestScore = s; parentIdx = i }
      })
      const slotIndex = anchorCount[parentIdx]++
      const orbitAngle = (slotIndex * 2.4) % (2 * Math.PI) // golden angle spiral
      const orbitR = ORBIT_BASE * Math.max(0.5, 1.2 - score)

      const anchor = anchors[parentIdx]
      return {
        id: track.id, track,
        x: anchor.x + orbitR * Math.cos(orbitAngle) + (Math.random() - 0.5) * 20,
        y: anchor.y + orbitR * Math.sin(orbitAngle) + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0,
        isAnchor: false, score,
        parentIdx, orbitAngle, orbitR,
        dismissed: false,
      }
    })

    nodesRef.current = [...anchors, ...cands]
    ticksRef.current = 60  // run physics for up to 60 ticks
    startPhysics()
  }, [anchorTracks, candidates, canvasSize])

  // ── Physics ─────────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    const nodes = nodesRef.current
    const anchors = nodes.filter((n) => n.isAnchor)
    const movers  = nodes.filter((n) => !n.isAnchor)
    let maxV = 0

    // Repulsion between every pair of non-anchor nodes
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const dx = movers[j].x - movers[i].x
        const dy = movers[j].y - movers[i].y
        const dist2 = dx * dx + dy * dy
        if (dist2 < 1) continue
        const dist = Math.sqrt(dist2)
        const eff  = Math.max(dist, MIN_DIST)
        const f    = REPULSION / (eff * eff)
        const fx = (dx / dist) * f, fy = (dy / dist) * f
        movers[i].vx -= fx; movers[i].vy -= fy
        movers[j].vx += fx; movers[j].vy += fy
      }
      // Repulsion from anchors
      for (const anc of anchors) {
        const dx = movers[i].x - anc.x, dy = movers[i].y - anc.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DIST)
        const f    = (REPULSION * 0.5) / (dist * dist)
        movers[i].vx += (dx / dist) * f
        movers[i].vy += (dy / dist) * f
      }
    }

    // Spring attraction toward orbit position
    for (const node of movers) {
      const anc = anchors[node.parentIdx]
      if (!anc) continue
      const tx = anc.x + node.orbitR * Math.cos(node.orbitAngle)
      const ty = anc.y + node.orbitR * Math.sin(node.orbitAngle)
      node.vx += (tx - node.x) * SPRING_K
      node.vy += (ty - node.y) * SPRING_K
    }

    // Integrate, damp, clamp to canvas
    const { w, h } = canvasSize
    const PAD = 20
    for (const node of movers) {
      node.vx *= DAMPING; node.vy *= DAMPING
      node.x += node.vx; node.y += node.vy
      node.x = Math.max(PAD, Math.min(w - PAD, node.x))
      node.y = Math.max(PAD, Math.min(h - PAD, node.y))
      maxV = Math.max(maxV, Math.abs(node.vx), Math.abs(node.vy))
    }

    return maxV
  }, [canvasSize])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = canvasSize

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0d0b08'
    ctx.fillRect(0, 0, w, h)

    const nodes   = nodesRef.current
    const anchors = nodes.filter((n) => n.isAnchor)
    const movers  = nodes.filter((n) => !n.isAnchor)

    // ── Candidate → anchor faint dotted lines ─────────────────────────────────
    ctx.setLineDash([2, 4])
    for (const node of movers) {
      const anc = anchors[node.parentIdx]
      if (!anc) continue
      ctx.beginPath()
      ctx.moveTo(node.x, node.y); ctx.lineTo(anc.x, anc.y)
      ctx.strokeStyle = `rgba(110,101,83,${node.score * 0.15})`
      ctx.lineWidth = 0.5; ctx.stroke()
    }
    ctx.setLineDash([])

    // ── Anchor → anchor edges ─────────────────────────────────────────────────
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1]
      const { color, width } = edgeColor(a.track, b.track)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke()
    }

    // ── Candidate nodes ───────────────────────────────────────────────────────
    for (const node of movers) {
      const r = 7 + node.score * 5
      const col = keyBlipColor(node.track.key)
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
      ctx.fillStyle = col + Math.round(40 + node.score * 140).toString(16).padStart(2, '0')
      ctx.fill()
      if (node.id === hoverNode?.id) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }

    // ── Anchor nodes ──────────────────────────────────────────────────────────
    for (const node of anchors) {
      ctx.beginPath(); ctx.arc(node.x, node.y, 18, 0, Math.PI * 2)
      ctx.fillStyle = '#1a1612'; ctx.fill()
      ctx.strokeStyle = keyBlipColor(node.track.key); ctx.lineWidth = 2; ctx.stroke()

      // Label
      ctx.fillStyle = 'rgba(235,229,211,0.85)'
      ctx.font = `bold ${9 * dpr / dpr}px 'JetBrains Mono', monospace`
      ctx.textAlign = 'center'
      ctx.fillText(
        (node.track.title.length > 12 ? node.track.title.slice(0, 11) + '…' : node.track.title),
        node.x, node.y + 30
      )
      ctx.fillStyle = 'rgba(180,170,155,0.45)'; ctx.font = `7px 'JetBrains Mono', monospace`
      if (node.track.bpm) ctx.fillText(`${node.track.bpm.toFixed(0)} · ${node.track.key ?? '—'}`, node.x, node.y + 40)
    }

    // ── Empty state ───────────────────────────────────────────────────────────
    if (anchors.length === 0) {
      ctx.fillStyle = 'rgba(180,170,155,0.2)'
      ctx.font = `11px 'JetBrains Mono', monospace`
      ctx.textAlign = 'center'
      ctx.fillText('add 1–2 seed tracks to start exploring', w / 2, h / 2)
    }
  }, [canvasSize, hoverNode])

  const startPhysics = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const loop = () => {
      if (ticksRef.current <= 0) { draw(); return }
      const maxV = tick()
      ticksRef.current--
      draw()
      if (maxV > SETTLE_V && ticksRef.current > 0) {
        rafRef.current = requestAnimationFrame(loop)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [tick, draw])

  // Rebuild on data change
  useEffect(() => { buildNodes() }, [buildNodes])
  // Redraw on hover change
  useEffect(() => { draw() }, [draw])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = container
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr; canvas.height = h * dpr
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
      const ctx = canvas.getContext('2d')
      ctx?.scale(dpr, dpr)
      setCanvasSize({ w, h })
    })
    ro.observe(container)
    return () => { ro.disconnect(); if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])

  // ── Hit test ─────────────────────────────────────────────────────────────────
  const hitTest = useCallback((cx: number, cy: number): GNode | null => {
    let best: GNode | null = null, bestDist = 24
    for (const n of nodesRef.current) {
      const r = n.isAnchor ? 18 : 7 + n.score * 5
      const d = Math.hypot(cx - n.x, cy - n.y)
      if (d < r + 6 && d < bestDist) { bestDist = d; best = n }
    }
    return best
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const hit = hitTest(mx, my)
    setHoverNode(hit)
    setHoverPos(hit ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null)
  }, [hitTest])

  const onMouseLeave = useCallback(() => { setHoverNode(null); setHoverPos(null) }, [])

  const onClick = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top)
    if (!hit) return
    if (hit.isAnchor) { onLoadA(hit.track); return }
    if (!activeChapterId) return
    await onAddTracks(activeChapterId, [hit.track.id])
    // Node will be removed from candidates on next render since it's now inChapterIds
  }, [hitTest, activeChapterId, onAddTracks, onLoadA])

  const onContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top)
    if (!hit || hit.isAnchor) return
    // Dismiss candidate
    setDismissed((prev) => new Set([...prev, hit.id]))
  }, [hitTest])

  const MOOD_LABEL = (m: number | null) => {
    if (m == null) return null
    if (m < -0.6) return 'Dark'
    if (m < -0.2) return 'Melancholic'
    if (m <  0.2) return 'Neutral'
    if (m <  0.6) return 'Uplifting'
    return 'Euphoric'
  }

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ background: '#0d0b08' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor: hoverNode ? (hoverNode.isAnchor ? 'pointer' : 'cell') : 'default' }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />

      {/* Hover tooltip */}
      {hoverNode && hoverPos && (
        <div
          className="pointer-events-none absolute z-20 bg-[#1a1612] border border-white/10 rounded overflow-hidden"
          style={{
            left:  hoverPos.x + 14,
            top:   hoverPos.y - 10,
            transform: hoverPos.x > (canvasSize.w ?? 600) * 0.65 ? 'translateX(calc(-100% - 28px))' : undefined
          }}
        >
          <div className="flex items-stretch">
            {/* Album art */}
            {hoverArtwork && (
              <img src={hoverArtwork} alt="" className="w-14 h-14 object-cover shrink-0" />
            )}
            {/* Text */}
            <div className="px-3 py-2 space-y-0.5 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="font-mono text-[10px] font-bold text-ink max-w-[200px] truncate">{hoverNode.track.title}</p>
                {/* Preview pulse — shown once audio starts */}
                {previewId === hoverNode.track.id && (
                  <span className="flex items-center gap-0.5 shrink-0" title="previewing">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-0.5 rounded-full bg-accent animate-pulse"
                        style={{ height: `${6 + i * 3}px`, animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </span>
                )}
              </div>
              <p className="font-mono text-[9px] text-muted truncate">{hoverNode.track.artist}</p>
              <div className="flex items-center gap-2 pt-0.5">
                {hoverNode.track.bpm != null    && <span className="font-mono text-[8.5px] text-ink-soft">{hoverNode.track.bpm.toFixed(1)} bpm</span>}
                {hoverNode.track.key            && <span className="font-mono text-[8.5px] font-bold" style={{ color: keyBlipColor(hoverNode.track.key) }}>{hoverNode.track.key}</span>}
                {hoverNode.track.energy != null && <span className="font-mono text-[8.5px] text-muted">nrg {hoverNode.track.energy}</span>}
                {MOOD_LABEL(hoverNode.track.mood ?? null) && <span className="font-mono text-[8.5px] text-muted">{MOOD_LABEL(hoverNode.track.mood ?? null)}</span>}
              </div>
              {!hoverNode.isAnchor && (
                <div className="flex items-center gap-2 pt-0.5">
                  <div className="flex-1 h-0.5 bg-border/20 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${hoverNode.score * 100}%`, background: '#D86A4A' }} />
                  </div>
                  <span className="font-mono text-[8px] text-muted tabular-nums">{Math.round(hoverNode.score * 100)}%</span>
                  <span className="font-mono text-[8px] text-muted/50">click to add · right-click dismiss</span>
                </div>
              )}
              {hoverNode.isAnchor && (
                <p className="font-mono text-[8px] text-muted/50 pt-0.5">click to load on deck A</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3 flex items-center gap-3 pointer-events-none">
        {[['#4A9B6F','harmonic'],['#C9A02C','bpm'],['#4E7090','mood'],['rgba(110,101,83,0.6)','general']] .map(([c, l]) => (
          <div key={l} className="flex items-center gap-1">
            <div className="w-5 h-0.5 rounded-full" style={{ background: c }} />
            <span className="font-mono text-[7.5px] uppercase tracking-[0.1em]" style={{ color: 'rgba(180,170,155,0.4)' }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Hint */}
      <div className="absolute bottom-3 right-3 font-mono text-[8px] pointer-events-none"
        style={{ color: 'rgba(180,170,155,0.2)' }}>
        click candidate to add · right-click to dismiss
      </div>
    </div>
  )
}
