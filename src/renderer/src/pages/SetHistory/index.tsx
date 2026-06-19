// Set History tab (Phase 1): surfaces played sets (is_history playlists + the
// set_sessions metadata layer) on a gig-density heatmap + list, with a detail
// pane — running order, transition deltas, summary stats, and inline editing
// of rating/venue/vibe/notes plus archive/delete.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import type { SetSummary, SetDetail } from '../../../../shared/types'

function mmss(sec: number | null): string {
  if (!sec || sec <= 0) return '—'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
function fmtDate(iso: string | null): string {
  if (!iso) return 'Undated'
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}
const dayKey = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null)

export function SetHistoryPage(): JSX.Element {
  const [sets, setSets] = useState<SetSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SetDetail | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async (): Promise<void> => {
    const s = await window.api.setHistory.list({ includeArchived })
    setSets(s)
    setLoading(false)
  }, [includeArchived])
  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let live = true
    void window.api.setHistory.get(selectedId).then((d) => { if (live) setDetail(d) })
    return () => { live = false }
  }, [selectedId])

  const patch = async (p: Partial<SetDetail>): Promise<void> => {
    if (!detail) return
    const updated = await window.api.setHistory.update(detail.id, p)
    if (updated) setDetail(updated)
    void reload()
  }
  const onDelete = async (): Promise<void> => {
    if (!detail) return
    const warn = detail.notes || detail.rating ? ' It has notes/rating you added.' : ''
    if (!window.confirm(`Delete "${detail.title}"? This removes the set and its track list.${warn}`)) return
    await window.api.setHistory.delete(detail.id)
    setSelectedId(null)
    void reload()
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of sets) {
      const k = dayKey(s.playedOn)
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [sets])

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        marker="◷"
        title="Set History"
        subtitle={loading ? 'Loading…' : `${sets.length} set${sets.length === 1 ? '' : 's'}`}
        right={
          <label className="font-mono text-[11px] text-muted flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            show archived
          </label>
        }
      />

      <div className="px-5 pt-4 shrink-0">
        <Heatmap counts={counts} onPickDay={(day) => {
          const first = sets.find((s) => dayKey(s.playedOn) === day)
          if (first) setSelectedId(first.id)
        }} />
      </div>

      <div className="flex-1 min-h-0 flex gap-4 px-5 py-4">
        {/* list */}
        <div className="w-[42%] min-w-[300px] overflow-y-auto pr-1 flex flex-col gap-1.5">
          {!loading && sets.length === 0 && (
            <p className="font-mono text-[12px] text-muted/70 mt-6 leading-relaxed">
              No sets yet. Sets appear here after you import a Pioneer HISTORY (USB) or capture a live set —
              each becomes a card you can rate, tag and review.
            </p>
          )}
          {sets.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`text-left rounded border px-3 py-2.5 transition-colors ${
                selectedId === s.id ? 'border-accent/60 bg-accent/[0.07]' : 'border-border/30 hover:bg-ink/[0.04]'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[13px] text-ink truncate">{s.title || '(untitled set)'}</span>
                <span className="font-mono text-[10px] text-muted shrink-0">{fmtDate(s.playedOn)}</span>
              </div>
              <div className="flex items-center gap-2.5 mt-1 font-mono text-[10px] text-muted/80">
                <span>{s.trackCount ?? 0} trks</span>
                <span>{mmss(s.durationSec)}</span>
                {s.avgBpm != null && <span>{Math.round(s.avgBpm)} BPM</span>}
                {s.harmonicPct != null && <span>{Math.round(s.harmonicPct)}% harm</span>}
                {s.rating ? <span className="text-[#C9A02C]">{'★'.repeat(s.rating)}</span> : null}
                {s.status === 'archived' && <span className="text-muted/50">archived</span>}
              </div>
            </button>
          ))}
        </div>

        {/* detail */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {detail ? <SetDetailPane detail={detail} onPatch={patch} onDelete={onDelete} /> : (
            <div className="h-full flex items-center justify-center">
              <p className="font-mono text-[12px] text-muted/50">Select a set</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SetDetailPane({
  detail,
  onPatch,
  onDelete
}: {
  detail: SetDetail
  onPatch: (p: Partial<SetDetail>) => void
  onDelete: () => void
}): JSX.Element {
  const [venue, setVenue] = useState(detail.venue ?? '')
  const [vibe, setVibe] = useState(detail.vibe ?? '')
  const [notes, setNotes] = useState(detail.notes ?? '')
  useEffect(() => { setVenue(detail.venue ?? ''); setVibe(detail.vibe ?? ''); setNotes(detail.notes ?? '') }, [detail.id])

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-mono text-[16px] font-bold text-ink truncate">{detail.title || '(untitled set)'}</h2>
            <p className="font-mono text-[11px] text-muted mt-0.5">
              {fmtDate(detail.playedOn)} · {detail.source}{detail.device ? ` · ${detail.device}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onPatch({ status: detail.status === 'archived' ? 'kept' : 'archived' })}
              className="font-mono text-[11px] text-muted hover:text-ink border border-border/40 rounded px-2 py-1"
            >
              {detail.status === 'archived' ? 'Unarchive' : 'Archive'}
            </button>
            <button onClick={onDelete} className="font-mono text-[11px] text-rec hover:opacity-80 border border-rec/40 rounded px-2 py-1">
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="TRACKS" value={`${detail.trackCount ?? 0}`} />
        <Stat label="LENGTH" value={mmss(detail.durationSec)} />
        <Stat label="AVG BPM" value={detail.avgBpm != null ? `${Math.round(detail.avgBpm)}` : '—'} />
        <Stat label="BPM RANGE" value={detail.bpmMin != null && detail.bpmMax != null ? `${Math.round(detail.bpmMin)}–${Math.round(detail.bpmMax)}` : '—'} />
        <Stat label="HARMONIC" value={detail.harmonicPct != null ? `${Math.round(detail.harmonicPct)}%` : '—'} />
        <Stat label="ENERGY" value={detail.energyAvg != null ? detail.energyAvg.toFixed(1) : '—'} />
      </div>

      {/* rating + venue + vibe */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((r) => (
            <button key={r} onClick={() => onPatch({ rating: detail.rating === r ? null : r })} className="text-[15px] leading-none"
              style={{ color: (detail.rating ?? 0) >= r ? '#C9A02C' : 'rgb(var(--ink-rgb) / 0.25)' }}>★</button>
          ))}
        </div>
        <input
          value={venue} onChange={(e) => setVenue(e.target.value)} onBlur={() => onPatch({ venue: venue.trim() || null })}
          placeholder="Venue"
          className="font-mono text-[12px] bg-paper border border-border/40 rounded px-2 py-1 text-ink w-44 placeholder:text-muted/50"
        />
        <input
          value={vibe} onChange={(e) => setVibe(e.target.value)} onBlur={() => onPatch({ vibe: vibe.trim() || null })}
          placeholder="Vibe (warm-up / peak / closing)"
          className="font-mono text-[12px] bg-paper border border-border/40 rounded px-2 py-1 text-ink flex-1 min-w-[140px] placeholder:text-muted/50"
        />
      </div>

      <textarea
        value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => onPatch({ notes: notes.trim() || null })}
        placeholder="Debrief notes…" rows={2}
        className="font-mono text-[12px] bg-paper border border-border/40 rounded px-2.5 py-2 text-ink resize-y placeholder:text-muted/50"
      />

      {/* running order */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted mb-1.5">Running order</p>
        <div className="flex flex-col">
          {detail.tracks.map((t, i) => {
            const tr = detail.transitions.find((x) => x.index === i)
            const rough = tr && (tr.harmonic === false || (tr.bpmDelta != null && Math.abs(tr.bpmDelta) > 8))
            return (
              <div key={i} className="flex items-center gap-2 py-1 border-b border-border/15">
                <span className="font-mono text-[10px] text-muted/60 w-6 text-right tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12px] text-ink truncate">{t.title || '(unknown track)'}</p>
                  <p className="font-mono text-[10px] text-muted/70 truncate">{t.artist || '—'}</p>
                </div>
                <span className="font-mono text-[10px] text-muted tabular-nums w-12 text-right">{t.bpm ? Math.round(t.bpm) : '—'}</span>
                <span className="font-mono text-[10px] text-accent w-8 text-right">{t.key || ''}</span>
                {tr && (
                  <span className={`font-mono text-[9px] w-12 text-right ${rough ? 'text-rec' : 'text-muted/40'}`}>
                    {tr.bpmDelta != null ? `${tr.bpmDelta > 0 ? '+' : ''}${tr.bpmDelta}` : ''}{tr.harmonic === false ? ' ✗' : ''}
                  </span>
                )}
              </div>
            )
          })}
          {detail.tracks.length === 0 && <p className="font-mono text-[11px] text-muted/60 py-2">No tracks recorded for this set.</p>}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="bg-paper border border-border/30 rounded px-3 py-2">
      <p className="font-mono text-[15px] font-bold text-ink tabular-nums leading-none">{value}</p>
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted mt-1.5">{label}</p>
    </div>
  )
}

/** 52-week gig-density heatmap (GitHub-contributions style), at set granularity. */
function Heatmap({ counts, onPickDay }: { counts: Map<string, number>; onPickDay: (day: string) => void }): JSX.Element {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const start = new Date(today); start.setDate(start.getDate() - 364)
  const dow = start.getDay()
  start.setDate(start.getDate() + (dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow)) // align Monday
  const max = Math.max(1, ...counts.values())

  const weeks: { iso: string; count: number }[][] = []
  const cur = new Date(start)
  for (let w = 0; w < 52; w++) {
    const week: { iso: string; count: number }[] = []
    for (let d = 0; d < 7; d++) {
      const iso = cur.toISOString().slice(0, 10)
      week.push({ iso, count: counts.get(iso) ?? 0 })
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(week)
  }
  const color = (c: number): string => {
    if (c === 0) return 'rgb(var(--ink-rgb) / 0.06)'
    return `rgba(216,106,74,${(0.3 + Math.min(1, c / max) * 0.7).toFixed(2)})`
  }
  return (
    <div className="flex gap-[3px]">
      {weeks.map((week, i) => (
        <div key={i} className="flex flex-col gap-[3px]">
          {week.map((d) => (
            <div
              key={d.iso}
              title={`${d.iso}: ${d.count} set${d.count === 1 ? '' : 's'}`}
              onClick={() => d.count > 0 && onPickDay(d.iso)}
              className={`w-[9px] h-[9px] rounded-[2px] ${d.count > 0 ? 'cursor-pointer' : ''}`}
              style={{ backgroundColor: color(d.count) }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
