/**
 * Orders — Running Order workspace
 *
 * Each running order is an editorial programme document:
 *   N° 001 · "Basement · Saturday, 28 June"
 *
 * Features:
 *   · Three-lens arc canvas (BPM · Energy · Keys)
 *   · Drag-to-reorder track list
 *   · Per-entry: flexible flag, planned transition badge, freeform note
 *   · Inline annotations between entries
 *   · PDF programme export (via Electron printToPDF)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import type { Playlist } from '@shared/types'
import { keyBlipColor } from '../../components/CamelotWheel'
import { compatibilityScore, camelotDistance, harmonicScore } from '../../lib/compatibility'
import { scoreLibrary, transitionContext } from '../../lib/roadNotTaken'
import type { RunningOrder, OrderEntry, TransitionKind, Track } from '@shared/types'
import { randomUUID } from '../../lib/uuid'

// ── Tiny UUID shim (renderer has no Node crypto) ─────────────────────────────
// imported from a small helper; fall back to Math.random if unavailable

// ── Constants ─────────────────────────────────────────────────────────────────

const TRANSITION_KINDS: TransitionKind[] = ['blend', 'cut', 'echo-out', 'loop-roll']
const TRANSITION_COLORS: Record<TransitionKind, string> = {
  blend: '#4A9B6F', cut: '#B86E72', 'echo-out': '#C9A02C', 'loop-roll': '#4E7090'
}

type Lens = 'bpm' | 'energy' | 'keys'

// ── Arc canvas ────────────────────────────────────────────────────────────────

function OrderArc({ tracks, lens }: { tracks: (Track | null)[]; lens: Lens }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth, H = canvas.offsetHeight
    canvas.width = W * dpr; canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const n = tracks.length
    if (n === 0) return

    const PAD = { l: 28, r: 12, t: 8, b: 16 }
    const pw = W - PAD.l - PAD.r
    const ph = H - PAD.t - PAD.b

    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    ctx.fillRect(PAD.l, PAD.t, pw, ph)

    const xs = tracks.map((_, i) => PAD.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw))

    if (lens === 'bpm') {
      const bpms = tracks.map((t) => t?.bpm ?? null)
      const valid = bpms.filter(Boolean) as number[]
      if (!valid.length) return
      const lo = Math.min(...valid) - 2, hi = Math.max(...valid) + 2
      const toY = (b: number) => PAD.t + ph - ((b - lo) / (hi - lo)) * ph

      // Grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1
      for (const g of [0.25, 0.5, 0.75]) {
        const y = PAD.t + ph - g * ph
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + pw, y); ctx.stroke()
        ctx.fillStyle = 'rgba(180,170,155,0.35)'
        ctx.font = `${7 * dpr / dpr}px 'JetBrains Mono', monospace`
        ctx.textAlign = 'right'
        ctx.fillText(String(Math.round(lo + g * (hi - lo))), PAD.l - 3, y + 3)
      }

      // Line
      ctx.beginPath(); ctx.strokeStyle = '#D86A4A'; ctx.lineWidth = 1.5
      let first = true
      tracks.forEach((t, i) => {
        if (!t?.bpm) return
        const y = toY(t.bpm)
        if (first) { ctx.moveTo(xs[i], y); first = false } else ctx.lineTo(xs[i], y)
      })
      ctx.stroke()

      // Dots
      tracks.forEach((t, i) => {
        if (!t?.bpm) return
        ctx.beginPath()
        ctx.arc(xs[i], toY(t.bpm), 3, 0, Math.PI * 2)
        ctx.fillStyle = '#D86A4A'; ctx.fill()
      })

    } else if (lens === 'energy') {
      const vals = tracks.map((t) => t?.energy ?? null)

      // Area fill
      ctx.beginPath()
      ctx.moveTo(xs[0], PAD.t + ph)
      tracks.forEach((t, i) => {
        const v = t?.energy ?? 0
        ctx.lineTo(xs[i], PAD.t + ph - (v / 10) * ph)
      })
      ctx.lineTo(xs[n - 1], PAD.t + ph)
      ctx.closePath()
      const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + ph)
      grad.addColorStop(0, 'rgba(216,106,74,0.30)')
      grad.addColorStop(1, 'rgba(216,106,74,0.04)')
      ctx.fillStyle = grad; ctx.fill()

      // Line + dots
      ctx.beginPath(); ctx.strokeStyle = '#D86A4A'; ctx.lineWidth = 1.5
      let first = true
      tracks.forEach((t, i) => {
        if (t?.energy == null) return
        const y = PAD.t + ph - (t.energy / 10) * ph
        if (first) { ctx.moveTo(xs[i], y); first = false } else ctx.lineTo(xs[i], y)
      })
      ctx.stroke()
      tracks.forEach((t, i) => {
        if (t?.energy == null) return
        const y = PAD.t + ph - (t.energy / 10) * ph
        ctx.beginPath(); ctx.arc(xs[i], y, 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(216,106,74,${0.4 + (t.energy / 10) * 0.6})`; ctx.fill()
      })

      // Y-axis labels (1 5 10)
      ctx.fillStyle = 'rgba(180,170,155,0.35)'
      ctx.font = `7px 'JetBrains Mono', monospace`; ctx.textAlign = 'right'
      for (const v of [1, 5, 10]) {
        const y = PAD.t + ph - ((v - 1) / 9) * ph
        ctx.fillText(String(v), PAD.l - 3, y + 3)
      }

    } else {
      // Keys — colored segment per track
      const segW = pw / n
      tracks.forEach((t, i) => {
        const color = keyBlipColor(t?.key ?? null)
        ctx.fillStyle = color + (t?.key ? 'cc' : '20')
        ctx.fillRect(PAD.l + i * segW, PAD.t, segW - 1, ph)
        if (t?.key) {
          ctx.fillStyle = 'rgba(255,255,255,0.75)'
          ctx.font = `bold 8px 'JetBrains Mono', monospace`
          ctx.textAlign = 'center'
          ctx.fillText(t.key, PAD.l + i * segW + segW / 2, PAD.t + ph / 2 + 3)
        }
      })

      // Connecting lines between compatible keys
      for (let i = 0; i < n - 1; i++) {
        const a = tracks[i]?.key, b = tracks[i + 1]?.key
        if (!a || !b) continue
        const x1 = PAD.l + i * segW + segW - 0.5
        const x2 = PAD.l + (i + 1) * segW + 0.5
        const mid = (x1 + x2) / 2
        ctx.beginPath()
        ctx.moveTo(x1, PAD.t + ph / 2)
        ctx.bezierCurveTo(mid, PAD.t + ph / 2, mid, PAD.t + ph / 2, x2, PAD.t + ph / 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.stroke()
      }
    }

    // Track index ticks along bottom
    ctx.fillStyle = 'rgba(180,170,155,0.25)'; ctx.textAlign = 'center'
    ctx.font = `6px 'JetBrains Mono', monospace`
    tracks.forEach((_, i) => ctx.fillText(String(i + 1), xs[i], H - 3))

  }, [tracks, lens])

  return (
    <canvas ref={canvasRef} className="w-full" style={{ height: 88, display: 'block' }} />
  )
}

// ── Entry row ─────────────────────────────────────────────────────────────────

function EntryRow({
  entry, index, track, nextTrack, isLast,
  onToggleFlexible, onSetTransition, onSetNote, onRemove,
  onDragStart, onDragOver, onDrop, isDragOver,
}: {
  entry: OrderEntry; index: number; track: Track | null; nextTrack: Track | null; isLast: boolean
  onToggleFlexible: () => void
  onSetTransition: (k: TransitionKind | null) => void
  onSetNote: (note: string) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  isDragOver: boolean
}): JSX.Element {
  const [editingNote, setEditingNote] = useState(false)
  const [noteVal, setNoteVal] = useState(entry.note ?? '')
  const [showTrans, setShowTrans] = useState(false)

  return (
    <div
      className={`group relative border-b transition-colors
        ${isDragOver ? 'border-accent/50 bg-accent/[0.04]' : 'border-border/20 hover:bg-ink/[0.025]'}`}
      style={{ borderColor: isDragOver ? undefined : 'rgba(var(--border-rgb)/0.2)' }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(e) }}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Drag handle + index */}
        <div
          className="shrink-0 flex items-center gap-1.5 cursor-grab active:cursor-grabbing"
          draggable
          onDragStart={onDragStart}
        >
          <span className="font-mono text-[8px] text-muted/40 w-5 text-right tabular-nums select-none">{index + 1}</span>
          <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor" className="text-muted/25 shrink-0">
            <rect x="0" y="0" width="3" height="2" rx="0.5"/>
            <rect x="5" y="0" width="3" height="2" rx="0.5"/>
            <rect x="0" y="4" width="3" height="2" rx="0.5"/>
            <rect x="5" y="4" width="3" height="2" rx="0.5"/>
            <rect x="0" y="8" width="3" height="2" rx="0.5"/>
            <rect x="5" y="8" width="3" height="2" rx="0.5"/>
          </svg>
        </div>

        {/* Key blip */}
        <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: keyBlipColor(track?.key ?? null) }} />

        {/* Title / artist */}
        <div className="flex-1 min-w-0">
          <p className={`font-mono text-[10px] truncate ${entry.flexible ? 'text-muted/60 italic' : 'text-ink'}`}>
            {track?.title ?? '?'}
            {entry.flexible && <span className="ml-1 text-[8px] not-italic text-muted/40">[flex]</span>}
          </p>
          <p className="font-mono text-[8.5px] text-muted/60 truncate">{track?.artist ?? ''}</p>
        </div>

        {/* BPM / Key */}
        <div className="shrink-0 text-right hidden sm:block">
          <p className="font-mono text-[9px] text-ink-soft tabular-nums">{track?.bpm?.toFixed(1) ?? '—'}</p>
          <p className="font-mono text-[8.5px] font-bold" style={{ color: keyBlipColor(track?.key ?? null) }}>{track?.key ?? '—'}</p>
        </div>

        {/* Duration */}
        <span className="font-mono text-[9px] text-muted/50 tabular-nums shrink-0 hidden md:block">
          {track?.durationSeconds ? `${Math.floor(track.durationSeconds/60)}:${String(Math.round(track.durationSeconds%60)).padStart(2,'0')}` : '—'}
        </span>

        {/* Flexible toggle */}
        <button
          onClick={onToggleFlexible}
          title={entry.flexible ? 'Committed cut' : 'Mark as swap-in candidate'}
          className={`shrink-0 w-5 h-5 rounded flex items-center justify-center transition-colors
            ${entry.flexible ? 'bg-amber-500/15 text-amber-400' : 'text-muted/30 hover:text-muted'}`}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 8 L5 2 L8 8"/>
            <line x1="3.5" y1="6" x2="6.5" y2="6"/>
          </svg>
        </button>

        {/* Remove */}
        <button
          onClick={onRemove}
          className="shrink-0 w-5 h-5 flex items-center justify-center text-muted/25 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
        >×</button>
      </div>

      {/* Note row */}
      {(entry.note || editingNote) && (
        <div className="px-10 pb-1.5">
          {editingNote ? (
            <input
              autoFocus
              value={noteVal}
              onChange={(e) => setNoteVal(e.target.value)}
              onBlur={() => { onSetNote(noteVal); setEditingNote(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { onSetNote(noteVal); setEditingNote(false) } }}
              className="w-full bg-transparent border-b border-border/30 focus:border-accent/50 font-mono text-[9px] text-ink placeholder:text-muted/40 focus:outline-none pb-0.5"
              placeholder="add a note…"
            />
          ) : (
            <p
              className="font-mono text-[8.5px] text-muted/60 italic cursor-text hover:text-muted transition-colors"
              onClick={() => { setNoteVal(entry.note ?? ''); setEditingNote(true) }}
            >
              {entry.note}
            </p>
          )}
        </div>
      )}

      {/* Transition badge between entries (not shown on last) */}
      {!isLast && (
        <div className="flex items-center gap-2 px-10 pb-1">
          {entry.plannedTransition ? (
            <button
              onClick={() => setShowTrans((v) => !v)}
              className="flex items-center gap-1"
            >
              <span
                className="font-mono text-[7.5px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
                style={{
                  color: TRANSITION_COLORS[entry.plannedTransition.kind],
                  background: TRANSITION_COLORS[entry.plannedTransition.kind] + '18'
                }}
              >
                → {entry.plannedTransition.kind}
                {entry.plannedTransition.bars ? ` · ${entry.plannedTransition.bars}b` : ''}
              </span>
            </button>
          ) : (
            <button
              onClick={() => setShowTrans((v) => !v)}
              className="font-mono text-[7.5px] uppercase tracking-[0.1em] text-muted/25 hover:text-muted/60 transition-colors"
            >
              + transition
            </button>
          )}
          {!editingNote && !entry.note && (
            <button
              onClick={() => { setNoteVal(''); setEditingNote(true) }}
              className="font-mono text-[7.5px] uppercase tracking-[0.1em] text-muted/20 hover:text-muted/50 transition-colors"
            >
              + note
            </button>
          )}
        </div>
      )}

      {/* Transition picker popover */}
      {showTrans && (
        <div className="absolute z-20 left-10 bottom-2 bg-chassis border border-border/40 rounded shadow-xl flex gap-1 p-1">
          {TRANSITION_KINDS.map((k) => (
            <button key={k}
              onClick={() => { onSetTransition(k); setShowTrans(false) }}
              className={`font-mono text-[8px] uppercase tracking-[0.08em] px-2 py-1 rounded transition-colors
                ${entry.plannedTransition?.kind === k ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink hover:bg-ink/[0.05]'}`}
              style={{ color: entry.plannedTransition?.kind === k ? TRANSITION_COLORS[k] : undefined }}
            >
              {k}
            </button>
          ))}
          {entry.plannedTransition && (
            <button onClick={() => { onSetTransition(null); setShowTrans(false) }}
              className="font-mono text-[8px] text-muted/40 hover:text-red-400 px-1 rounded transition-colors">
              ×
            </button>
          )}
        </div>
      )}

      {/* ── Transition connector ── */}
      {!isLast && (() => {
        const fromKey = track?.key ?? null
        const toKey   = nextTrack?.key ?? null
        const dist    = camelotDistance(fromKey, toKey)
        const score   = harmonicScore(fromKey, toKey)
        const bpmDelta = track?.bpm != null && nextTrack?.bpm != null
          ? (nextTrack.bpm - track.bpm)
          : null
        const dotColor = dist === 0 ? '#4A9B6F' : dist === 1 ? '#6BAA7E' : dist === 2 ? '#C9A02C' : '#B86E72'
        return (
          <div className="flex items-center gap-2 px-9 py-0.5" style={{ background: 'rgba(255,255,255,0.012)' }}>
            {/* Key journey */}
            {fromKey && toKey ? (
              <>
                <span className="font-mono text-[7.5px]" style={{ color: keyBlipColor(fromKey) }}>{fromKey}</span>
                <span className="text-[7px] text-muted/25">→</span>
                <span className="font-mono text-[7.5px]" style={{ color: keyBlipColor(toKey) }}>{toKey}</span>
                {/* Compatibility dots (5 max) */}
                <div className="flex items-center gap-0.5">
                  {[0,1,2,3,4].map((i) => (
                    <span key={i} className="w-1 h-1 rounded-full"
                      style={{ background: i < Math.round(score * 5) ? dotColor : 'rgba(255,255,255,0.08)' }} />
                  ))}
                </div>
                {dist === 0 && <span className="font-mono text-[6.5px] text-emerald-500/60 uppercase tracking-[0.08em]">perfect</span>}
                {dist === 1 && <span className="font-mono text-[6.5px] text-green-400/50 uppercase tracking-[0.08em]">compatible</span>}
                {dist >= 3 && <span className="font-mono text-[6.5px] text-amber-500/50 uppercase tracking-[0.08em]">risky</span>}
              </>
            ) : (
              <span className="font-mono text-[7px] text-muted/20">—</span>
            )}
            {/* BPM delta */}
            {bpmDelta != null && Math.abs(bpmDelta) > 0.5 && (
              <span className="font-mono text-[7px] text-muted/30 ml-1 tabular-nums">
                {bpmDelta > 0 ? '+' : ''}{bpmDelta.toFixed(0)} bpm
              </span>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ── Orders page ───────────────────────────────────────────────────────────────

export function OrdersPage(): JSX.Element {
  const { tracks, playlists } = useLibraryStore()

  const [orders, setOrders] = useState<RunningOrder[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false)
  const [lens, setLens] = useState<Lens>('bpm')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleVal, setTitleVal] = useState('')
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [isDraggingLibTracks, setIsDraggingLibTracks] = useState(false)
  // Road Not Taken state
  const [showRnt, setShowRnt] = useState(false)
  const [rntSlot, setRntSlot] = useState(0)   // index: 0 = before track 1, N = after track N
  // USB import state
  type UsbSet = { name: string; usbId: string; date: string | null; tracks: { title: string; artist: string; bpm: number | null; key: string | null; durationSeconds: number | null; position: number; localTrackId: string | null }[] }
  const [usbSets, setUsbSets] = useState<UsbSet[] | null>(null)
  const [usbLoading, setUsbLoading] = useState(false)

  useEffect(() => {
    window.api.library.getRunningOrders().then((ros) => {
      setOrders(ros)
      if (ros.length > 0 && !activeId) setActiveId(ros[0].id)
    })
  }, [])

  const active = orders.find((o) => o.id === activeId) ?? null

  // Track map
  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])

  const activeTrackList = useMemo(
    () => (active?.entries ?? []).map((e) => trackMap.get(e.trackId) ?? null),
    [active, trackMap]
  )

  // Persist helper
  const update = useCallback(async (patch: Partial<RunningOrder>) => {
    if (!active) return
    const updated = await window.api.library.updateRunningOrder(active.id, patch)
    setOrders((prev) => prev.map((o) => (o.id === active.id ? updated : o)))
  }, [active])

  // ── Entry mutations ──────────────────────────────────────────────────────────

  const patchEntry = useCallback((idx: number, patch: Partial<OrderEntry>) => {
    if (!active) return
    const entries = active.entries.map((e, i) => i === idx ? { ...e, ...patch } : e)
    update({ entries })
  }, [active, update])

  const removeEntry = useCallback((idx: number) => {
    if (!active) return
    update({ entries: active.entries.filter((_, i) => i !== idx) })
  }, [active, update])

  const addTracks = useCallback((trackIds: string[]) => {
    if (!active) return
    const existing = new Set(active.entries.map((e) => e.trackId))
    const newEntries: OrderEntry[] = trackIds
      .filter((id) => !existing.has(id))
      .map((id) => ({ id: crypto.randomUUID(), trackId: id, plannedTransition: null, note: null, flexible: false }))
    if (newEntries.length) update({ entries: [...active.entries, ...newEntries] })
  }, [active, update])

  // ── Drag-to-reorder ──────────────────────────────────────────────────────────

  const handleDrop = useCallback((dropIdx: number) => {
    if (dragFromIdx === null || !active) return
    if (dragFromIdx === dropIdx) { setDragFromIdx(null); setDragOverIdx(null); return }
    const entries = [...active.entries]
    const [moved] = entries.splice(dragFromIdx, 1)
    entries.splice(dropIdx > dragFromIdx ? dropIdx - 1 : dropIdx, 0, moved)
    update({ entries })
    setDragFromIdx(null); setDragOverIdx(null)
  }, [dragFromIdx, active, update])

  // ── Create / delete ──────────────────────────────────────────────────────────

  const createOrder = async () => {
    const date = new Date().toISOString().slice(0, 10)
    const ro = await window.api.library.createRunningOrder(`Set · ${date}`)
    setOrders((prev) => [...prev, ro])
    setActiveId(ro.id)
  }

  const createFromPlaylist = useCallback(async (pl: Playlist) => {
    setShowPlaylistPicker(false)
    const ro = await window.api.library.createRunningOrder(pl.name)
    const entries: OrderEntry[] = pl.trackIds.map((id) => ({
      id: crypto.randomUUID(), trackId: id, plannedTransition: null, note: null, flexible: false,
    }))
    const updated = { ...ro, entries }
    await window.api.library.updateRunningOrder(ro.id, { entries })
    setOrders((prev) => [...prev, updated])
    setActiveId(ro.id)
  }, [])

  // ── Pioneer USB import ───────────────────────────────────────────────────────

  const importFromUsb = useCallback(async () => {
    setUsbLoading(true)
    try {
      let usbRoot = await window.api.library.findPioneerUsb()
      if (!usbRoot) usbRoot = await window.api.library.browseForUsb()
      if (!usbRoot) return

      const result = await window.api.library.readUsbHistory(usbRoot)
      if ('error' in (result as Record<string, unknown>)) {
        alert(`Could not read USB: ${(result as { error: string }).error}`)
        return
      }
      const sets = result as UsbSet[]
      if (!sets.length) { alert('No HISTORY playlists found on this USB.'); return }
      setUsbSets(sets)
    } finally {
      setUsbLoading(false)
    }
  }, [])

  const importUsbSet = useCallback(async (chosen: UsbSet) => {
    const date = chosen.date ?? new Date().toISOString().slice(0, 10)
    const ro = await window.api.library.createRunningOrder(`${chosen.name} · ${date}`)
    const matchedIds = chosen.tracks
      .filter((t) => t.localTrackId)
      .map((t) => t.localTrackId as string)

    if (matchedIds.length) {
      const existingIds = new Set(ro.entries.map((e) => e.trackId))
      const newEntries: import('@shared/types').OrderEntry[] = matchedIds
        .filter((id) => !existingIds.has(id))
        .map((id) => ({ id: crypto.randomUUID(), trackId: id, plannedTransition: null, note: null, flexible: false }))
      const updated = { ...ro, entries: [...ro.entries, ...newEntries] }
      await window.api.library.updateRunningOrder(ro.id, { entries: updated.entries })
      setOrders((prev) => [...prev, updated])
    } else {
      setOrders((prev) => [...prev, ro])
    }
    setActiveId(ro.id)
    setUsbSets(null)
  }, [setOrders, setActiveId])

  const deleteOrder = async (id: string) => {
    await window.api.library.deleteRunningOrder(id)
    setOrders((prev) => prev.filter((o) => o.id !== id))
    if (activeId === id) setActiveId(orders.find((o) => o.id !== id)?.id ?? null)
  }

  // ── Library drag-drop (from Library page) ────────────────────────────────────

  const handleContainerDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-crate-track-ids')) {
      e.preventDefault()
      setIsDraggingLibTracks(true)
    }
  }
  const handleContainerDrop = (e: React.DragEvent) => {
    setIsDraggingLibTracks(false)
    try {
      const ids = JSON.parse(e.dataTransfer.getData('application/x-crate-track-ids')) as string[]
      addTracks(ids)
    } catch { /* not our format */ }
  }

  // ── Total duration ───────────────────────────────────────────────────────────

  const totalDurSec = useMemo(
    () => activeTrackList.reduce((s, t) => s + (t?.durationSeconds ?? 0), 0),
    [activeTrackList]
  )
  const fmtDur = (s: number) => `${Math.floor(s / 3600) > 0 ? `${Math.floor(s / 3600)}h ` : ''}${Math.floor((s % 3600) / 60)}m`

  // ── Set statistics ──────────────────────────────────────────────────────────

  const setStats = useMemo(() => {
    const ts = activeTrackList.filter(Boolean) as NonNullable<typeof activeTrackList[number]>[]
    if (ts.length < 2) return null

    // Average transition harmonic score
    let totalHarm = 0, harmCount = 0
    for (let i = 0; i < ts.length - 1; i++) {
      const s = harmonicScore(ts[i].key, ts[i + 1].key)
      totalHarm += s; harmCount++
    }
    const avgHarm = harmCount > 0 ? totalHarm / harmCount : 0

    // BPM range
    const bpms = ts.map((t) => t.bpm).filter((b): b is number => b != null)
    const bpmRange = bpms.length > 1
      ? `${Math.min(...bpms).toFixed(0)}–${Math.max(...bpms).toFixed(0)}`
      : bpms.length === 1 ? `${bpms[0].toFixed(0)}` : null

    // Most common key mode
    const modes = ts.map((t) => t.key?.toUpperCase().endsWith('B') ? 'major' : 'minor').filter(Boolean)
    const majorCount = modes.filter((m) => m === 'major').length
    const mode = modes.length > 0 ? (majorCount > modes.length / 2 ? 'major' : 'minor') : null

    return { avgHarm, bpmRange, mode }
  }, [activeTrackList])

  // ── Road Not Taken — scored candidates for a specific transition slot ────────
  const rntCandidates = useMemo(() => {
    if (!active || active.entries.length === 0) return []
    const playedIds = new Set(active.entries.map((e) => e.trackId))
    const from = rntSlot > 0 ? (activeTrackList[rntSlot - 1] ?? null) : null
    const to   = rntSlot < activeTrackList.length ? (activeTrackList[rntSlot] ?? null) : null
    const ctx  = transitionContext(from, to, playedIds)
    return scoreLibrary(tracks, ctx, 8)
  }, [active, activeTrackList, tracks, rntSlot])

  const rntSlotLabels = useMemo(() => {
    if (!active) return []
    return active.entries.map((_, i) => {
      const from = activeTrackList[i - 1]?.title ?? null
      const to   = activeTrackList[i]?.title ?? null
      if (i === 0) return `Opening slot (before "${to ?? '…'}")`
      return `After "${from ?? '…'}" → "${to ?? '…'}"`
    })
  }, [active, activeTrackList])

  // ── What's next — freshness-weighted suggestions ─────────────────────────────
  const suggestions = useMemo(() => {
    if (!active?.entries.length) return []
    const lastEntry = active.entries[active.entries.length - 1]
    const lastTrack = trackMap.get(lastEntry.trackId)
    if (!lastTrack) return []
    const inOrder = new Set(active.entries.map((e) => e.trackId))

    return tracks
      .filter((t) => !inOrder.has(t.id))
      .map((t) => {
        const base = compatibilityScore(lastTrack, t)
        // Freshness adjustment
        let freshnessBonus = 0
        if (t.lastPlayedAt) {
          const days = (Date.now() - new Date(t.lastPlayedAt).getTime()) / 86400000
          if (days > 180) freshnessBonus = +0.12   // rediscovery — hasn't been out in 6 months
          else if (days < 7) freshnessBonus = -0.08 // heavy rotation penalty
        } else if (t.playCount === 0) {
          freshnessBonus = +0.05                    // never played — slight positive
        }
        return { track: t, score: Math.min(1, Math.max(0, base + freshnessBonus)), freshnessBonus }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }, [active, tracks, trackMap])

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* ── Left panel — order list ──────────────────────────────────────── */}
      <div className="w-44 shrink-0 flex flex-col border-r border-border/30 bg-chassis">
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border/30">
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-accent">Orders</span>
          <div className="flex items-center gap-1 relative">
            <button onClick={importFromUsb}
              title="Import from Pioneer USB"
              className="font-mono text-[7.5px] text-muted/40 hover:text-accent transition-colors px-1">
              {usbLoading ? '…' : 'USB'}
            </button>
            {/* From playlist button */}
            <button
              onClick={() => setShowPlaylistPicker((v) => !v)}
              title="Create from playlist"
              className="font-mono text-[7.5px] text-muted/40 hover:text-accent transition-colors px-1">
              PL
            </button>
            <button onClick={createOrder}
              className="w-5 h-5 flex items-center justify-center text-muted hover:text-accent transition-colors text-base leading-none">
              +
            </button>
            {/* Playlist picker dropdown */}
            {showPlaylistPicker && (
              <div className="absolute top-full right-0 z-30 mt-1 w-52 bg-chassis border border-border/40 rounded shadow-xl max-h-60 overflow-y-auto">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
                  <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted/50">create from playlist</span>
                  <button onClick={() => setShowPlaylistPicker(false)} className="text-muted/30 hover:text-muted text-xs">✕</button>
                </div>
                {playlists.filter((p) => !p.isFolder && !p.isSmart && p.trackIds.length > 0).map((pl) => (
                  <button key={pl.id}
                    onClick={() => createFromPlaylist(pl)}
                    className="w-full text-left px-3 py-1.5 hover:bg-accent/[0.05] border-b border-border/10 transition-colors">
                    <p className="font-mono text-[9px] text-ink truncate">{pl.name}</p>
                    <p className="font-mono text-[7.5px] text-muted/40">{pl.trackIds.length} tracks</p>
                  </button>
                ))}
                {playlists.filter((p) => !p.isFolder && !p.isSmart && p.trackIds.length > 0).length === 0 && (
                  <p className="font-mono text-[8px] text-muted/30 px-3 py-2 italic">no playlists found</p>
                )}
              </div>
            )}
          </div>
        </div>
        {/* USB history picker */}
        {usbSets && (
          <div className="shrink-0 border-b border-border/30 bg-chassis-soft">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-accent">USB history</span>
              <button onClick={() => setUsbSets(null)} className="font-mono text-[8px] text-muted/40 hover:text-muted transition-colors">✕</button>
            </div>
            <div className="flex flex-col divide-y divide-border/20 max-h-40 overflow-y-auto">
              {usbSets.map((s) => {
                const matched = s.tracks.filter((t) => t.localTrackId).length
                return (
                  <button key={s.usbId}
                    onClick={() => importUsbSet(s)}
                    className="w-full text-left px-3 py-1.5 hover:bg-accent/[0.05] transition-colors">
                    <p className="font-mono text-[9px] text-ink">{s.name}</p>
                    <p className="font-mono text-[7.5px] text-muted/50">{s.tracks.length} tracks · {matched} in library{s.date ? ` · ${s.date}` : ''}</p>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {orders.length === 0 ? (
            <p className="px-3 py-4 font-mono text-[9px] text-muted/50 italic">no orders yet</p>
          ) : orders.map((o) => (
            <button
              key={o.id}
              onClick={() => setActiveId(o.id)}
              className={`w-full text-left px-3 py-2 border-b border-border/20 transition-colors group
                ${activeId === o.id ? 'bg-accent/[0.07]' : 'hover:bg-ink/[0.03]'}`}
            >
              <p className="font-mono text-[8px] text-muted/50 uppercase tracking-[0.1em]">
                N° {String(o.catalogNum).padStart(3, '0')}
              </p>
              <p className={`font-mono text-[9px] truncate ${activeId === o.id ? 'text-ink' : 'text-muted'}`}>
                {o.title || 'Untitled'}
              </p>
              <p className="font-mono text-[7.5px] text-muted/35">{o.entries.length} cuts</p>
            </button>
          ))}
        </div>
      </div>

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      {active ? (
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden"
          onDragOver={handleContainerDragOver}
          onDragLeave={() => setIsDraggingLibTracks(false)}
          onDrop={handleContainerDrop}
        >
          {/* Header */}
          <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border/30 bg-chassis">
            <span className="font-mono text-[9px] text-muted/50 uppercase tracking-[0.12em] shrink-0">
              N° {String(active.catalogNum).padStart(3, '0')}
            </span>
            {editingTitle ? (
              <input
                autoFocus
                value={titleVal}
                onChange={(e) => setTitleVal(e.target.value)}
                onBlur={() => { update({ title: titleVal }); setEditingTitle(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { update({ title: titleVal }); setEditingTitle(false) } }}
                className="flex-1 bg-transparent border-b border-accent/40 font-mono text-[11px] text-ink focus:outline-none"
              />
            ) : (
              <h2
                className="flex-1 font-mono text-[11px] text-ink cursor-text hover:text-accent transition-colors truncate"
                onClick={() => { setTitleVal(active.title); setEditingTitle(true) }}
              >
                {active.title || <span className="text-muted/40 italic">click to name this order</span>}
              </h2>
            )}

            <span className="font-mono text-[8.5px] text-muted/50 shrink-0 tabular-nums">
              {active.entries.length} cuts · {fmtDur(totalDurSec)}
              {setStats?.bpmRange && <span className="text-muted/35"> · {setStats.bpmRange} bpm</span>}
              {setStats && (
                <span title={`Avg harmonic compatibility: ${Math.round(setStats.avgHarm * 100)}%`}
                  style={{ marginLeft: 6, color: setStats.avgHarm >= 0.75 ? '#4A9B6F' : setStats.avgHarm >= 0.55 ? '#C9A02C' : '#B86E72' }}>
                  ⬡{Math.round(setStats.avgHarm * 100)}%
                </span>
              )}
            </span>

            {/* M3U export */}
            <button
              onClick={async () => {
                const filePaths = activeTrackList
                  .filter(Boolean)
                  .map((t) => t!.filePath)
                if (!filePaths.length) return
                const title = active.title || `Order-${active.catalogNum}`
                const m3u = '#EXTM3U\n' + activeTrackList
                  .filter(Boolean)
                  .map((t) => `#EXTINF:${Math.round(t!.durationSeconds ?? 0)},${t!.artist} - ${t!.title}\n${t!.filePath}`)
                  .join('\n')
                // Use IPC to show a save dialog and write the file
                const blob = new Blob([m3u], { type: 'audio/x-mpegurl' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${title.replace(/[^a-zA-Z0-9 ]/g, '').trim()}.m3u`
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="shrink-0 font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded px-2 py-0.5 transition-colors"
              title="Export as M3U playlist"
            >
              M3U
            </button>

            {/* PDF export */}
            <button
              onClick={async () => {
                const res = await window.api.library.exportOrderPDF(active.id)
                if (res.saved) console.log('PDF saved:', res.path)
              }}
              className="shrink-0 font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded px-2 py-0.5 transition-colors"
              title="Export as PDF programme"
            >
              PDF
            </button>

            {/* Delete */}
            <button
              onClick={() => deleteOrder(active.id)}
              className="shrink-0 font-mono text-[8.5px] text-muted/30 hover:text-red-400 transition-colors"
            >
              delete
            </button>
          </div>

          {/* Arc */}
          <div className="shrink-0 border-b border-border/20" style={{ background: '#0d0b08' }}>
            <div className="flex items-center gap-1 px-3 pt-2 pb-1">
              {(['bpm', 'energy', 'keys'] as Lens[]).map((l) => (
                <button key={l} onClick={() => setLens(l)}
                  className={`font-mono text-[8px] uppercase tracking-[0.08em] px-2 py-0.5 rounded transition-colors
                    ${lens === l ? 'bg-accent/15 text-accent' : 'text-muted/50 hover:text-muted'}`}>
                  {l}
                </button>
              ))}
            </div>
            <OrderArc tracks={activeTrackList} lens={lens} />
          </div>

          {/* Track list */}
          <div className={`flex-1 overflow-y-auto transition-colors ${isDraggingLibTracks ? 'bg-accent/[0.03]' : ''}`}>
            {active.entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 pointer-events-none">
                <p className="font-mono text-[11px] text-muted/30 uppercase tracking-[0.15em]">
                  {isDraggingLibTracks ? 'drop tracks here' : 'no tracks yet'}
                </p>
                <p className="font-mono text-[9px] text-muted/20">drag from the library or use the search below</p>
              </div>
            ) : (
              active.entries.map((entry, idx) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  index={idx}
                  track={trackMap.get(entry.trackId) ?? null}
                  nextTrack={idx < active.entries.length - 1 ? (trackMap.get(active.entries[idx + 1].trackId) ?? null) : null}
                  isLast={idx === active.entries.length - 1}
                  onToggleFlexible={() => patchEntry(idx, { flexible: !entry.flexible })}
                  onSetTransition={(k) => patchEntry(idx, {
                    plannedTransition: k ? { kind: k } : null
                  })}
                  onSetNote={(note) => patchEntry(idx, { note: note || null })}
                  onRemove={() => removeEntry(idx)}
                  onDragStart={() => setDragFromIdx(idx)}
                  onDragOver={() => setDragOverIdx(idx)}
                  onDrop={() => handleDrop(idx)}
                  isDragOver={dragOverIdx === idx && dragFromIdx !== idx}
                />
              ))
            )}

            {/* Drop sentinel at end */}
            {active.entries.length > 0 && (
              <div
                className={`h-10 transition-colors ${dragOverIdx === active.entries.length ? 'bg-accent/[0.06]' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(active.entries.length) }}
                onDrop={(e) => { e.preventDefault(); handleDrop(active.entries.length) }}
              />
            )}
          </div>
          {/* ── What's next strip ──────────────────────────────────────── */}
          {suggestions.length > 0 && (
            <div className="shrink-0 border-t border-border/25" style={{ background: '#0e0c09' }}>
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted/50">what's next?</span>
                <span className="font-mono text-[7.5px] text-muted/30">freshness-weighted · click to add</span>
              </div>
              <div className="flex overflow-x-auto gap-1.5 px-3 pb-2" style={{ scrollbarWidth: 'none' }}>
                {suggestions.map(({ track: t, score, freshnessBonus }) => (
                  <button
                    key={t.id}
                    onClick={() => addTracks([t.id])}
                    title={`${Math.round(score * 100)}% match${freshnessBonus > 0 ? ' · rediscovery +' : freshnessBonus < 0 ? ' · heavy rotation' : ''}`}
                    className="shrink-0 flex flex-col items-start bg-white/[0.03] hover:bg-accent/[0.06] border border-white/[0.05] hover:border-accent/25 rounded px-2 py-1.5 transition-colors text-left"
                    style={{ minWidth: 120, maxWidth: 160 }}
                  >
                    <div className="flex items-center gap-1.5 w-full mb-0.5">
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: keyBlipColor(t.key) }} />
                      <span className="font-mono text-[8.5px] font-bold text-ink truncate flex-1">{t.title}</span>
                      {freshnessBonus > 0 && (
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'rgba(201,160,44,0.70)' }} title="Rediscovery" />
                      )}
                    </div>
                    <p className="font-mono text-[7.5px] text-muted/60 truncate w-full">{t.artist}</p>
                    <div className="flex items-center gap-1.5 mt-1 w-full">
                      <div className="flex-1 h-0.5 bg-border/20 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${score * 100}%`, background: '#D86A4A' }} />
                      </div>
                      <span className="font-mono text-[7px] text-muted/40 tabular-nums shrink-0">{Math.round(score * 100)}%</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Road Not Taken ─────────────────────────────────────────── */}
          {active && active.entries.length >= 2 && (
            <div className="shrink-0 border-t border-border/25" style={{ background: '#09080a' }}>
              {/* Toggle header */}
              <button
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/[0.02] transition-colors"
                onClick={() => setShowRnt((v) => !v)}
              >
                <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted/40">
                  the road not taken
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[7.5px] text-muted/25">what else in your bag would have fit here?</span>
                  <span className="font-mono text-[8px] text-muted/30 transition-transform" style={{ display: 'inline-block', transform: showRnt ? 'rotate(90deg)' : 'none' }}>▸</span>
                </div>
              </button>

              {showRnt && (
                <div className="px-3 pb-3">
                  {/* Slot selector — pill per transition */}
                  <div className="flex flex-wrap gap-1 mb-2">
                    {rntSlotLabels.map((label, i) => (
                      <button
                        key={i}
                        onClick={() => setRntSlot(i)}
                        title={label}
                        className={`font-mono text-[7.5px] px-2 py-0.5 rounded transition-colors border ${
                          rntSlot === i
                            ? 'bg-accent/15 text-accent border-accent/30'
                            : 'text-muted/40 border-border/20 hover:text-muted hover:border-border/40'
                        }`}
                      >
                        {i === 0 ? '⟨open⟩' : `${i}→${i + 1}`}
                      </button>
                    ))}
                  </div>

                  {/* Context blurb */}
                  {(() => {
                    const from = rntSlot > 0 ? activeTrackList[rntSlot - 1] : null
                    const to   = activeTrackList[rntSlot] ?? null
                    return (
                      <p className="font-mono text-[7.5px] text-muted/35 mb-2 truncate">
                        {from ? `"${from.title}" → ` : 'Opening → '}
                        {to ? `"${to.title}"` : 'close'}
                        {from?.bpm && to?.bpm ? ` · ${from.bpm.toFixed(0)}→${to.bpm.toFixed(0)} bpm` : ''}
                      </p>
                    )
                  })()}

                  {/* Candidate cards */}
                  {rntCandidates.length === 0 ? (
                    <p className="font-mono text-[8px] text-muted/25 italic">no analysed tracks to compare</p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {rntCandidates.map(({ track: t, totalScore, scores, reason }) => (
                        <div key={t.id}
                          className="flex items-center gap-2 bg-white/[0.02] hover:bg-accent/[0.04] border border-border/15 hover:border-accent/20 rounded px-2 py-1.5 group transition-colors">
                          {/* Key blip */}
                          <span className="w-1.5 h-1.5 rounded-sm shrink-0 mt-0.5" style={{ background: keyBlipColor(t.key) }} />

                          {/* Track info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-1.5">
                              <span className="font-mono text-[8.5px] font-bold text-ink truncate">{t.title}</span>
                              <span className="font-mono text-[7px] text-muted/40 shrink-0">{t.artist}</span>
                            </div>
                            <p className="font-mono text-[7px] text-muted/35 truncate mt-0.5">{reason}</p>
                          </div>

                          {/* Factor pills */}
                          <div className="flex items-center gap-0.5 shrink-0">
                            {(['harmonic', 'tempo', 'energy', 'freshness'] as const).map((f) => {
                              const v = scores[f]
                              const color = v >= 0.75 ? '#4A9B6F' : v >= 0.5 ? '#C9A02C' : '#B86E72'
                              return (
                                <span key={f} title={`${f}: ${Math.round(v * 100)}%`}
                                  className="font-mono text-[6.5px] uppercase tracking-[0.06em] px-1 py-0.5 rounded"
                                  style={{ background: `${color}22`, color }}>
                                  {f[0]}
                                </span>
                              )
                            })}
                          </div>

                          {/* Score bar + add button */}
                          <div className="flex items-center gap-1.5 shrink-0 w-16">
                            <div className="flex-1 h-0.5 bg-border/20 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${totalScore * 100}%`, background: '#9B6B4A' }} />
                            </div>
                            <span className="font-mono text-[7px] text-muted/35 tabular-nums">{Math.round(totalScore * 100)}%</span>
                          </div>

                          <button
                            onClick={() => addTracks([t.id])}
                            className="shrink-0 font-mono text-[7px] text-muted/30 hover:text-accent group-hover:text-accent/60 transition-colors"
                            title="Add to order"
                          >
                            +add
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <p className="font-mono text-[11px] text-muted/30 uppercase tracking-[0.15em]">no orders</p>
            <button onClick={createOrder}
              className="font-mono text-[9px] uppercase tracking-[0.1em] text-accent hover:text-ink border border-accent/30 hover:border-accent/60 rounded px-4 py-2 transition-colors">
              create first order
            </button>
            <div className="pt-1">
              <button onClick={importFromUsb}
                className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted/40 hover:text-muted border border-border/20 hover:border-border/50 rounded px-3 py-1.5 transition-colors">
                ⬛ import from pioneer usb
              </button>
              <p className="font-mono text-[7px] text-muted/25 mt-1">reads HISTORY playlists from a plugged-in Pioneer USB</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
