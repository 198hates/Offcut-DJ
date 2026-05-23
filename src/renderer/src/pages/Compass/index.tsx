/**
 * Compass — Library Scatter Map
 *
 * Plots every track as a dot in 2D space.  Axes are switchable:
 *   X: danceability | bpm | mood
 *   Y: energy | bpm | mood
 *
 * Controls:
 *   Scroll wheel  — zoom (pivot on cursor)
 *   Drag          — pan
 *   Shift+drag    — lasso select
 *   Click dot     — open TrackDetail panel
 *   Hover dot     — tooltip (album art + title, artist, BPM, key, energy, mood)
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import { TrackDetail } from '../../components/TrackDetail'
import { useArtwork } from '../../hooks/useArtwork'
// deck stores reserved for future "load to deck" from Compass
// import { useDeckAStore, useDeckBStore } from '../../store/playerStore'
import type { Track } from '@shared/types'

// ── Constants ─────────────────────────────────────────────────────────────────

const MARGIN = { top: 24, right: 24, bottom: 40, left: 48 }
const BASE_DOT_R   = 5         // px at zoom 1
const MISSING_R    = 3.5       // px for no-data hollow dots
const MIN_ZOOM     = 0.25
const MAX_ZOOM     = 8
const ZOOM_FACTOR  = 1.12

type XAxis = 'danceability' | 'bpm' | 'mood'
type YAxis = 'energy' | 'bpm' | 'mood'
type ColorMode = 'key' | 'genre'

const MOOD_LABELS = ['Dark', 'Melancholic', 'Neutral', 'Uplifting', 'Euphoric']
const MOOD_RANGES = [[-1, -0.6], [-0.6, -0.2], [-0.2, 0.2], [0.2, 0.6], [0.6, 1]] as const
const MOOD_COLORS = ['#4a3860', '#6e5f8a', '#6e6553', '#c8904a', '#f5c842']

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map an axis value to [0, 1].  Returns null if the field is missing. */
function axisVal(track: Track, axis: XAxis | YAxis): number | null {
  switch (axis) {
    case 'danceability': return track.danceability         // already 0–1
    case 'energy':       return track.energy != null ? track.energy / 10 : null
    case 'bpm':          return track.bpm != null ? Math.min(1, Math.max(0, (track.bpm - 60) / 140)) : null
    case 'mood':         return track.mood != null ? (track.mood + 1) / 2 : null
  }
}

function axisLabel(axis: XAxis | YAxis): string {
  return { danceability: 'Danceability', bpm: 'BPM', mood: 'Mood', energy: 'Energy' }[axis]
}

/** Deterministic hue from a string for genre colouring */
function strHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff
  return h % 360
}

function genreColor(genre: string): string {
  if (!genre) return '#8A8474'
  return `hsl(${strHue(genre)}, 52%, 52%)`
}

/** Ray-cast point-in-polygon test */
function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Convex hull — Graham scan */
function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts
  const sorted = [...pts].sort(([ax, ay], [bx, by]) => ax !== bx ? ax - bx : ay - by)
  const cross = (O: [number, number], A: [number, number], B: [number, number]) =>
    (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])
  const lower: [number, number][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop(); upper.pop()
  return [...lower, ...upper]
}

// ── Compass page ──────────────────────────────────────────────────────────────

export function CompassPage(): JSX.Element {
  const { tracks, playlists } = useLibraryStore()
  // ── View state ──────────────────────────────────────────────────────────────
  const [xAxis, setXAxis]       = useState<XAxis>('danceability')
  const [yAxis, setYAxis]       = useState<YAxis>('energy')
  const [colorMode, setColorMode] = useState<ColorMode>('key')
  const [zoom, setZoom]         = useState(1)
  const [pan, setPan]           = useState({ x: 0, y: 0 })
  const [showClusters, setShowClusters] = useState(true)

  // ── Selection / detail ──────────────────────────────────────────────────────
  const [detailId,   setDetailId]   = useState<string | null>(null)
  const [hoverId,    setHoverId]    = useState<string | null>(null)
  const [hoverPos,   setHoverPos]   = useState<{ x: number; y: number } | null>(null)
  const [lassoIds,   setLassoIds]   = useState<Set<string>>(new Set())

  // ── Filters ─────────────────────────────────────────────────────────────────
  const [filterGenres, setFilterGenres] = useState<Set<string>>(new Set())
  const [filterKeys,   setFilterKeys]   = useState<Set<string>>(new Set())
  const [filterMoods,  setFilterMoods]  = useState<Set<number>>(new Set())  // indices 0–4
  const [showFilters,  setShowFilters]  = useState(false)

  // ── Canvas refs ─────────────────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef     = useRef<{ startX: number; startY: number; panStart: { x: number; y: number }; lasso: boolean } | null>(null)
  const lassoPointsRef = useRef<[number, number][]>([])
  const [lassoActive, setLassoActive] = useState(false)

  // ── Derived data ─────────────────────────────────────────────────────────────

  const autoGroupPlaylists = useMemo(() =>
    playlists.filter((p) => p.isAutoGroup && !p.isFolder),
    [playlists]
  )

  const allGenres = useMemo(() => {
    const s = new Set<string>()
    for (const t of tracks) if (t.genre) s.add(t.genre)
    return [...s].sort()
  }, [tracks])

  const allKeys = useMemo(() => {
    const order = ['1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A',
                   '1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']
    const s = new Set(tracks.map((t) => t.key).filter(Boolean) as string[])
    return order.filter((k) => s.has(k))
  }, [tracks])

  const keyDistribution = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tracks) {
      if (t.key) counts.set(t.key, (counts.get(t.key) ?? 0) + 1)
    }
    return counts
  }, [tracks])
  const maxKeyCount = useMemo(() => Math.max(1, ...keyDistribution.values()), [keyDistribution])

  // Filter visibility: dim non-matching dots
  const isFiltered = filterGenres.size > 0 || filterKeys.size > 0 || filterMoods.size > 0

  function trackPassesFilter(t: Track): boolean {
    if (filterGenres.size > 0 && !filterGenres.has(t.genre)) return false
    if (filterKeys.size > 0 && (!t.key || !filterKeys.has(t.key))) return false
    if (filterMoods.size > 0) {
      if (t.mood == null) return false
      const idx = MOOD_RANGES.findIndex(([lo, hi]) => t.mood! >= lo && t.mood! <= hi)
      if (!filterMoods.has(idx)) return false
    }
    return true
  }

  // ── Canvas transform helpers ──────────────────────────────────────────────────

  const getPlotSize = useCallback(() => {
    const c = canvasRef.current
    if (!c) return { w: 600, h: 400 }
    return {
      w: c.width  - MARGIN.left - MARGIN.right,
      h: c.height - MARGIN.top  - MARGIN.bottom,
    }
  }, [])

  /** Data [0,1] → canvas pixel */
  const toCanvas = useCallback((dx: number, dy: number, z: number, px: number, py: number) => {
    const { w, h } = getPlotSize()
    return {
      cx: MARGIN.left + dx * w * z + px,
      cy: MARGIN.top  + (1 - dy) * h * z + py,
    }
  }, [getPlotSize])

  // ── Draw ─────────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const { w, h } = getPlotSize()

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Background
    ctx.fillStyle = '#0d0b08'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Plot area subtle border
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    ctx.strokeRect(MARGIN.left, MARGIN.top, w * zoom, h * zoom)

    // Grid lines (at 0.25, 0.5, 0.75)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    for (const t of [0.25, 0.5, 0.75]) {
      const { cx } = toCanvas(t, 0, zoom, pan.x, pan.y)
      const { cy } = toCanvas(0, t, zoom, pan.x, pan.y)
      if (cx > MARGIN.left && cx < MARGIN.left + w) {
        ctx.beginPath()
        ctx.moveTo(cx, MARGIN.top); ctx.lineTo(cx, MARGIN.top + h * zoom)
        ctx.stroke()
      }
      if (cy > MARGIN.top && cy < MARGIN.top + h) {
        ctx.beginPath()
        ctx.moveTo(MARGIN.left, cy); ctx.lineTo(MARGIN.left + w * zoom, cy)
        ctx.stroke()
      }
    }

    // Axis labels
    ctx.fillStyle = 'rgba(180,170,155,0.55)'
    ctx.font = `${10 * dpr}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.fillText(axisLabel(xAxis).toUpperCase(), MARGIN.left + (w * zoom) / 2, canvas.height - 8)
    ctx.save()
    ctx.translate(12, MARGIN.top + (h * zoom) / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(axisLabel(yAxis).toUpperCase(), 0, 0)
    ctx.restore()

    // Clip to plot area
    ctx.save()
    ctx.beginPath()
    ctx.rect(MARGIN.left, MARGIN.top, w, h)   // clip to display area (not zoomed — panning/zoom is in coordinates)
    ctx.clip()

    // ── Cluster outlines ────────────────────────────────────────────────────
    if (showClusters) {
      const trackById = new Map(tracks.map((t) => [t.id, t]))
      for (const pl of autoGroupPlaylists) {
        const pts: [number, number][] = []
        for (const tid of pl.trackIds) {
          const t = trackById.get(tid)
          if (!t) continue
          const xv = axisVal(t, xAxis), yv = axisVal(t, yAxis)
          if (xv == null || yv == null) continue
          const { cx, cy } = toCanvas(xv, yv, zoom, pan.x, pan.y)
          pts.push([cx, cy])
        }
        if (pts.length < 2) continue
        const hull = pts.length >= 3 ? convexHull(pts) : pts

        ctx.beginPath()
        if (hull.length > 0) {
          ctx.moveTo(hull[0][0], hull[0][1])
          for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1])
          ctx.closePath()
        }
        ctx.strokeStyle = (pl.color || '#8A8474') + '60'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 3])
        ctx.stroke()
        ctx.fillStyle   = (pl.color || '#8A8474') + '10'
        ctx.fill()
        ctx.setLineDash([])
      }
    }

    // ── Dots ────────────────────────────────────────────────────────────────
    for (const track of tracks) {
      const xv = axisVal(track, xAxis)
      const yv = axisVal(track, yAxis)
      const missing = xv == null || yv == null
      const { cx, cy } = toCanvas(xv ?? 0.5, yv ?? 0.5, zoom, pan.x, pan.y)

      const passes = !isFiltered || trackPassesFilter(track)
      const isHover  = track.id === hoverId
      const isDetail = track.id === detailId
      const isLasso  = lassoIds.has(track.id)

      const dotR = missing ? MISSING_R : (BASE_DOT_R + (track.rating / 5) * 2.5) * Math.sqrt(zoom)

      let dotColor: string
      if (colorMode === 'key') dotColor = keyBlipColor(track.key)
      else dotColor = genreColor(track.genre)

      const alpha = passes ? (missing ? 0.3 : 0.85) : 0.08

      ctx.beginPath()
      ctx.arc(cx, cy, isHover || isDetail ? dotR * 1.35 : dotR, 0, Math.PI * 2)

      if (missing) {
        ctx.strokeStyle = `rgba(138,132,116,${alpha})`
        ctx.lineWidth   = 1
        ctx.stroke()
      } else {
        ctx.fillStyle = dotColor
        ctx.globalAlpha = alpha
        ctx.fill()
        ctx.globalAlpha = 1

        if (isHover || isDetail || isLasso) {
          ctx.strokeStyle = isDetail ? '#ffffff' : isLasso ? '#D86A4A' : 'rgba(255,255,255,0.6)'
          ctx.lineWidth   = isDetail ? 2 : 1.5
          ctx.stroke()
        }
      }
    }

    ctx.restore()   // unclip

    // ── Lasso outline ────────────────────────────────────────────────────────
    if (lassoActive && lassoPointsRef.current.length > 1) {
      const pts = lassoPointsRef.current
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
      ctx.closePath()
      ctx.strokeStyle = 'rgba(216,106,74,0.7)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([5, 3])
      ctx.stroke()
      ctx.fillStyle = 'rgba(216,106,74,0.07)'
      ctx.fill()
      ctx.setLineDash([])
    }
  }, [tracks, xAxis, yAxis, colorMode, zoom, pan, hoverId, detailId, lassoIds,
      lassoActive, isFiltered, filterGenres, filterKeys, filterMoods,
      autoGroupPlaylists, showClusters, getPlotSize, toCanvas])

  // Redraw whenever state changes
  useEffect(() => { draw() }, [draw])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    const ro = new ResizeObserver(() => {
      canvas.width  = container.clientWidth  * dpr
      canvas.height = container.clientHeight * dpr
      canvas.style.width  = container.clientWidth  + 'px'
      canvas.style.height = container.clientHeight + 'px'
      const ctx = canvas.getContext('2d')
      ctx?.scale(dpr, dpr)
      draw()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [draw])

  // ── Hit testing ──────────────────────────────────────────────────────────────

  const hitTest = useCallback((clientX: number, clientY: number): Track | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top

    let best: Track | null = null
    let bestDist = 20   // px threshold

    for (const track of tracks) {
      const xv = axisVal(track, xAxis)
      const yv = axisVal(track, yAxis)
      const { cx, cy } = toCanvas(xv ?? 0.5, yv ?? 0.5, zoom, pan.x, pan.y)
      const d = Math.hypot(mx - cx, my - cy)
      if (d < bestDist) { bestDist = d; best = track }
    }
    return best
  }, [tracks, xAxis, yAxis, zoom, pan, toCanvas])

  // ── Mouse events ─────────────────────────────────────────────────────────────

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY

      if (dragRef.current.lasso) {
        // Lasso mode
        const canvas = canvasRef.current!
        const rect = canvas.getBoundingClientRect()
        lassoPointsRef.current.push([e.clientX - rect.left, e.clientY - rect.top])
        setLassoActive(true)
        draw()
      } else {
        // Pan mode
        setPan({
          x: dragRef.current.panStart.x + dx,
          y: dragRef.current.panStart.y + dy,
        })
      }
      return
    }

    const hit = hitTest(e.clientX, e.clientY)
    if (hit?.id !== hoverId) {
      setHoverId(hit?.id ?? null)
      if (hit) {
        const canvas = canvasRef.current!
        const rect = canvas.getBoundingClientRect()
        setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      } else {
        setHoverPos(null)
      }
    }
  }, [dragRef, hitTest, hoverId, draw])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      panStart: pan,
      lasso: e.shiftKey,
    }
    if (e.shiftKey) {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      lassoPointsRef.current = [[e.clientX - rect.left, e.clientY - rect.top]]
      setLassoActive(true)
      setLassoIds(new Set())
    }
  }, [pan])

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    const { startX, startY, lasso } = dragRef.current
    const didMove = Math.hypot(e.clientX - startX, e.clientY - startY) > 4

    if (lasso) {
      // Finish lasso — find tracks inside polygon
      const poly = lassoPointsRef.current
      const selected = new Set<string>()
      for (const track of tracks) {
        const xv = axisVal(track, xAxis)
        const yv = axisVal(track, yAxis)
        const { cx, cy } = toCanvas(xv ?? 0.5, yv ?? 0.5, zoom, pan.x, pan.y)
        if (pointInPolygon(cx, cy, poly)) selected.add(track.id)
      }
      setLassoIds(selected)
      setLassoActive(false)
      lassoPointsRef.current = []
      draw()
    } else if (!didMove) {
      // Click — open detail
      const hit = hitTest(e.clientX, e.clientY)
      setDetailId(hit?.id ?? null)
      setLassoIds(new Set())
    }

    dragRef.current = null
  }, [tracks, xAxis, yAxis, zoom, pan, hitTest, toCanvas, draw])

  const onMouseLeave = useCallback(() => {
    setHoverId(null)
    setHoverPos(null)
    if (dragRef.current?.lasso) {
      setLassoActive(false)
      lassoPointsRef.current = []
      dragRef.current = null
    }
  }, [])

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))

    // Pivot zoom on cursor: adjust pan so that data under cursor stays fixed
    setPan((prev) => ({
      x: mx - (mx - prev.x) * (newZoom / zoom),
      y: my - (my - prev.y) * (newZoom / zoom),
    }))
    setZoom(newZoom)
  }, [zoom])

  // Reset view
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  // ── Lasso action bar ──────────────────────────────────────────────────────────

  const lassoTrackList = useMemo(() =>
    tracks.filter((t) => lassoIds.has(t.id)),
    [tracks, lassoIds]
  )

  const sendLassoToSetBuilder = useCallback(async () => {
    if (!lassoTrackList.length) return
    const { addTracksToPlaylist, playlists: pls } = useLibraryStore.getState()
    // Find first non-folder playlist or prompt — for now, use last active chapter
    const chapter = pls.find((p) => !p.isFolder && !p.isSmart)
    if (!chapter) return
    await addTracksToPlaylist(chapter.id, lassoTrackList.map((t) => t.id))
    setLassoIds(new Set())
  }, [lassoTrackList])

  const [lassoOrders, setLassoOrders] = useState<{ id: string; title: string; catalogNum: number }[]>([])
  const [showLassoOrderPicker, setShowLassoOrderPicker] = useState(false)

  const sendLassoToOrder = useCallback(async (orderId: string) => {
    if (!lassoTrackList.length) return
    const orders = await window.api.library.getRunningOrders()
    const order = orders.find((o) => o.id === orderId)
    if (!order) return
    const existingSet = new Set(order.entries.map((e) => e.trackId))
    const newEntries = [
      ...order.entries,
      ...lassoTrackList
        .filter((t) => !existingSet.has(t.id))
        .map((t) => ({ id: crypto.randomUUID(), trackId: t.id, plannedTransition: null, note: null, flexible: false as const }))
    ]
    await window.api.library.updateRunningOrder(orderId, { entries: newEntries })
    setLassoIds(new Set())
    setShowLassoOrderPicker(false)
  }, [lassoTrackList])

  // ── Hover tooltip ─────────────────────────────────────────────────────────────

  const hoverTrack = useMemo(() =>
    hoverId ? tracks.find((t) => t.id === hoverId) ?? null : null,
    [hoverId, tracks]
  )

  // Album art for whichever track is currently hovered (null when no hover)
  const hoverArtwork = useArtwork(hoverTrack?.filePath)

  const MOOD_LABEL = (m: number) => MOOD_LABELS[MOOD_RANGES.findIndex(([lo, hi]) => m >= lo && m <= hi)] ?? 'Neutral'

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden bg-[#0d0b08]">
      {/* ── Main canvas area ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Toolbar */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] bg-[#111009]">
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-accent mr-1">Compass</span>

          {/* Axis selectors */}
          <span className="font-mono text-[9px] text-muted uppercase tracking-[0.1em]">X</span>
          {(['danceability', 'bpm', 'mood'] as XAxis[]).map((a) => (
            <button key={a} onClick={() => setXAxis(a)}
              className={`font-mono text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
                ${xAxis === a ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
              {a}
            </button>
          ))}

          <div className="w-px h-4 bg-white/10 mx-1" />

          <span className="font-mono text-[9px] text-muted uppercase tracking-[0.1em]">Y</span>
          {(['energy', 'bpm', 'mood'] as YAxis[]).map((a) => (
            <button key={a} onClick={() => setYAxis(a)}
              className={`font-mono text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
                ${yAxis === a ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
              {a}
            </button>
          ))}

          <div className="w-px h-4 bg-white/10 mx-1" />

          {/* Colour mode */}
          <span className="font-mono text-[9px] text-muted uppercase tracking-[0.1em]">Colour</span>
          {(['key', 'genre'] as ColorMode[]).map((m) => (
            <button key={m} onClick={() => setColorMode(m)}
              className={`font-mono text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
                ${colorMode === m ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
              {m}
            </button>
          ))}

          <div className="flex-1" />

          {/* Clusters toggle */}
          <button onClick={() => setShowClusters((v) => !v)}
            className={`font-mono text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
              ${showClusters ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
            clusters
          </button>

          {/* Filter */}
          <button onClick={() => setShowFilters((v) => !v)}
            className={`font-mono text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
              ${(showFilters || isFiltered) ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
            filter{isFiltered ? ' •' : ''}
          </button>

          {/* Reset view */}
          <button onClick={resetView} className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted hover:text-ink transition-colors px-2 py-0.5 rounded">
            reset
          </button>

          <span className="font-mono text-[9px] text-muted/40 tabular-nums">
            {tracks.length.toLocaleString()} tracks
          </span>
        </div>

        {/* Canvas + overlay */}
        <div className="relative flex-1 min-h-0" ref={containerRef}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            style={{ cursor: lassoActive ? 'crosshair' : hoverId ? 'pointer' : 'grab' }}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
            onWheel={onWheel}
          />

          {/* Hover tooltip */}
          {hoverTrack && hoverPos && (
            <div
              className="pointer-events-none absolute z-20 bg-[#1a1612] border border-white/10 rounded overflow-hidden"
              style={{
                left:  hoverPos.x + 14,
                top:   hoverPos.y - 10,
                transform: hoverPos.x > (canvasRef.current?.offsetWidth ?? 600) * 0.65
                  ? 'translateX(calc(-100% - 28px))' : undefined,
              }}
            >
              <div className="flex items-stretch">
                {/* Album art — shown when available */}
                {hoverArtwork && (
                  <img
                    src={hoverArtwork}
                    alt=""
                    className="w-14 h-14 object-cover shrink-0"
                  />
                )}
                {/* Text content */}
                <div className="px-3 py-2 space-y-0.5 min-w-0">
                  <p className="font-mono text-[10px] font-bold text-ink max-w-[200px] truncate">
                    {hoverTrack.title || hoverTrack.filePath.split('/').pop()}
                  </p>
                  <p className="font-mono text-[9px] text-muted truncate">{hoverTrack.artist}</p>
                  <div className="flex items-center gap-2 pt-0.5">
                    {hoverTrack.bpm    != null && <span className="font-mono text-[8.5px] text-ink-soft">{hoverTrack.bpm.toFixed(1)} bpm</span>}
                    {hoverTrack.key               && <span className="font-mono text-[8.5px] font-bold" style={{ color: keyBlipColor(hoverTrack.key) }}>{hoverTrack.key}</span>}
                    {hoverTrack.energy != null && <span className="font-mono text-[8.5px] text-muted">nrg {hoverTrack.energy}</span>}
                    {hoverTrack.mood   != null && <span className="font-mono text-[8.5px] text-muted">{MOOD_LABEL(hoverTrack.mood)}</span>}
                  </div>
                  {(axisVal(hoverTrack, xAxis) == null || axisVal(hoverTrack, yAxis) == null) && (
                    <p className="font-mono text-[8px] text-muted/50">needs analysis</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Lasso action bar */}
          {lassoIds.size > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-[#1a1612] border border-accent/30 rounded-lg px-4 py-2 shadow-xl">
              <span className="font-mono text-[10px] text-ink">
                {lassoIds.size.toLocaleString()} track{lassoIds.size !== 1 ? 's' : ''} selected
              </span>
              <button onClick={sendLassoToSetBuilder}
                className="font-mono text-[9px] uppercase tracking-[0.1em] text-accent hover:text-ink border border-accent/40 hover:bg-accent/10 px-3 py-1 rounded transition-colors">
                add to set builder
              </button>
              {/* Add to running order */}
              <div className="relative">
                <button
                  onClick={async () => {
                    const ros = await window.api.library.getRunningOrders()
                    setLassoOrders(ros.map((r) => ({ id: r.id, title: r.title, catalogNum: r.catalogNum })))
                    setShowLassoOrderPicker((v) => !v)
                  }}
                  className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-white/20 hover:bg-white/[0.06] px-3 py-1 rounded transition-colors">
                  → order
                </button>
                {showLassoOrderPicker && lassoOrders.length > 0 && (
                  <div className="absolute bottom-9 left-0 bg-chassis border border-border/40 rounded shadow-xl min-w-[180px]">
                    {lassoOrders.map((ro) => (
                      <button key={ro.id}
                        onClick={() => sendLassoToOrder(ro.id)}
                        className="w-full text-left px-3 py-1.5 border-b border-border/20 last:border-0 font-mono text-[9px] text-muted hover:text-ink hover:bg-ink/[0.05] transition-colors">
                        N° {String(ro.catalogNum).padStart(3,'0')} · {ro.title || 'Untitled'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={async () => {
                  const name = window.prompt('New playlist name:', 'Compass selection')
                  if (!name?.trim()) return
                  const { createPlaylist, addTracksToPlaylist } = useLibraryStore.getState()
                  const pl = await createPlaylist(name.trim())
                  await addTracksToPlaylist(pl.id, lassoTrackList.map((t) => t.id))
                  setLassoIds(new Set())
                }}
                className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink border border-white/20 hover:bg-white/[0.06] px-3 py-1 rounded transition-colors">
                + playlist
              </button>
              <button onClick={() => setLassoIds(new Set())}
                className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors">
                clear
              </button>
            </div>
          )}

          {/* Hint overlay (empty state) */}
          {tracks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="font-mono text-[11px] text-muted/40 uppercase tracking-[0.15em]">import tracks to begin</p>
            </div>
          )}
          {tracks.length > 0 && (() => {
            const withX = tracks.filter((t) => axisVal(t, xAxis) != null).length
            const withY = tracks.filter((t) => axisVal(t, yAxis) != null).length
            if (withX === 0 || withY === 0) return (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center space-y-2 px-8">
                  <p className="font-mono text-[10px] text-white/30 uppercase tracking-[0.15em]">no data for {axisLabel(withX === 0 ? xAxis : yAxis).toLowerCase()}</p>
                  <p className="font-mono text-[8.5px] text-white/20 leading-relaxed">
                    run Analysis → BPM + Key to populate energy and danceability,<br/>or switch axes using the controls above
                  </p>
                </div>
              </div>
            )
            return null
          })()}

          {/* Zoom hint */}
          <div className="absolute bottom-3 right-3 font-mono text-[8px] text-white/15 pointer-events-none select-none">
            scroll to zoom · drag to pan · shift+drag to lasso
          </div>
        </div>
      </div>

      {/* ── Filter sidebar ───────────────────────────────────────────────── */}
      {showFilters && (
        <div className="shrink-0 w-52 border-l border-white/[0.06] bg-[#111009] flex flex-col overflow-hidden">
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.15em] text-accent">Filters</span>
            {isFiltered && (
              <button onClick={() => { setFilterGenres(new Set()); setFilterKeys(new Set()); setFilterMoods(new Set()) }}
                className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted hover:text-accent transition-colors">
                clear
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
            {/* Mood */}
            <div>
              <p className="font-mono text-[8.5px] uppercase tracking-[0.15em] text-muted mb-1.5">Mood</p>
              <div className="space-y-1">
                {MOOD_LABELS.map((label, i) => {
                  const on = filterMoods.has(i)
                  return (
                    <button key={label}
                      onClick={() => setFilterMoods((prev) => {
                        const next = new Set(prev)
                        on ? next.delete(i) : next.add(i)
                        return next
                      })}
                      className={`w-full text-left flex items-center gap-2 px-2 py-1 rounded transition-colors
                        ${on ? 'bg-accent/10' : 'hover:bg-white/[0.04]'}`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: MOOD_COLORS[i] }} />
                      <span className={`font-mono text-[9px] ${on ? 'text-ink' : 'text-muted'}`}>{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Key distribution */}
            {allKeys.length > 0 && (
              <div>
                <p className="font-mono text-[8.5px] uppercase tracking-[0.15em] text-muted mb-1.5">Key · distribution</p>
                <div className="space-y-0.5">
                  {allKeys.map((k) => {
                    const on    = filterKeys.has(k)
                    const count = keyDistribution.get(k) ?? 0
                    const pct   = count / maxKeyCount
                    return (
                      <button key={k}
                        onClick={() => setFilterKeys((prev) => {
                          const next = new Set(prev)
                          on ? next.delete(k) : next.add(k)
                          return next
                        })}
                        className={`w-full flex items-center gap-2 px-1.5 py-0.5 rounded transition-colors
                          ${on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
                      >
                        <span className="font-mono text-[8px] w-8 text-right shrink-0"
                          style={{ color: keyBlipColor(k), opacity: on ? 1 : 0.65 }}>
                          {k}
                        </span>
                        <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${pct * 100}%`, background: keyBlipColor(k), opacity: on ? 0.8 : 0.35 }} />
                        </div>
                        <span className="font-mono text-[7px] text-muted/40 w-5 text-right tabular-nums shrink-0">{count}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Genre */}
            {allGenres.length > 0 && (
              <div>
                <p className="font-mono text-[8.5px] uppercase tracking-[0.15em] text-muted mb-1.5">Genre</p>
                <div className="space-y-0.5">
                  {allGenres.map((g) => {
                    const on = filterGenres.has(g)
                    return (
                      <button key={g}
                        onClick={() => setFilterGenres((prev) => {
                          const next = new Set(prev); on ? next.delete(g) : next.add(g); return next
                        })}
                        className={`w-full text-left px-2 py-0.5 rounded font-mono text-[9px] truncate transition-colors
                          ${on ? 'bg-accent/10 text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.04]'}`}
                      >
                        {g}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Track detail panel ───────────────────────────────────────────── */}
      {detailId && (
        <TrackDetail
          trackId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
