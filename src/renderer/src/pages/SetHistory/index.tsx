// Set History tab (Phase 1): surfaces played sets (is_history playlists + the
// set_sessions metadata layer) on a gig-density heatmap + list, with a detail
// pane — running order, transition deltas, summary stats, and inline editing
// of rating/venue/vibe/notes plus archive/delete.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import type { SetSummary, SetDetail, UsbHistoryPreview, Residency, ResidencyDashboard, SetComparison, SetCompareSide } from '../../../../shared/types'

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
  const [importing, setImporting] = useState(false)
  const [comparing, setComparing] = useState<string | null>(null)
  const [residencies, setResidencies] = useState<Residency[]>([])
  const [resFilter, setResFilter] = useState<string | null>(null) // selected residency id
  const [dashboard, setDashboard] = useState<ResidencyDashboard | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const s = await window.api.setHistory.list({ includeArchived, residencyId: resFilter ?? undefined })
    setSets(s)
    setResidencies(await window.api.residencies.list())
    setLoading(false)
  }, [includeArchived, resFilter])
  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (!resFilter) { setDashboard(null); return }
    let live = true
    void window.api.residencies.dashboard(resFilter).then((d) => { if (live) setDashboard(d) })
    return () => { live = false }
  }, [resFilter, sets])

  const newResidency = async (): Promise<void> => {
    const name = window.prompt('New residency name (e.g. "The Cause")')?.trim()
    if (!name) return
    const r = await window.api.residencies.create({ name, color: '#B07A4E' })
    setResidencies(await window.api.residencies.list())
    setResFilter(r.id)
  }

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
          <div className="flex items-center gap-4">
            <label className="font-mono text-[11px] text-muted flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              show archived
            </label>
            <button
              onClick={() => setImporting(true)}
              className="font-mono text-[11px] text-accent border border-accent/40 rounded px-2.5 py-1 hover:bg-accent/[0.08] transition-colors"
            >⟱ Import from USB</button>
          </div>
        }
      />

      {importing && <ImportUsbModal onClose={() => setImporting(false)} onImported={() => { setImporting(false); void reload() }} />}
      {comparing && <CompareModal aId={comparing} sets={sets} onClose={() => setComparing(null)} />}

      <div className="px-5 pt-4 shrink-0">
        <Heatmap counts={counts} onPickDay={(day) => {
          const first = sets.find((s) => dayKey(s.playedOn) === day)
          if (first) setSelectedId(first.id)
        }} />
      </div>

      {/* residency pills */}
      <div className="px-5 pt-3 shrink-0 flex items-center gap-1.5 flex-wrap">
        <Pill active={!resFilter} onClick={() => setResFilter(null)}>All</Pill>
        {residencies.map((r) => (
          <Pill key={r.id} active={resFilter === r.id} color={r.color} onClick={() => setResFilter(resFilter === r.id ? null : r.id)}>
            {r.name} · {r.setCount}
          </Pill>
        ))}
        <button onClick={newResidency} className="font-mono text-[11px] text-muted/70 hover:text-accent px-2 py-1">＋ residency</button>
      </div>

      {dashboard && <ResidencyPanel d={dashboard} />}

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
          {detail ? <SetDetailPane detail={detail} residencies={residencies} onPatch={patch} onDelete={onDelete} onCompare={() => setComparing(detail.id)} /> : (
            <div className="h-full flex items-center justify-center">
              <p className="font-mono text-[12px] text-muted/50">Select a set</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ImportUsbModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }): JSX.Element {
  const [usbRoot, setUsbRoot] = useState<string | null>(null)
  const [previews, setPreviews] = useState<UsbHistoryPreview[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (root: string): Promise<void> => {
    setError(null); setPreviews(null); setUsbRoot(root)
    const res = await window.api.setHistory.listUsb(root)
    if ('error' in res) { setError(res.error); return }
    setPreviews(res)
    setSelected(new Set(res.filter((p) => !p.alreadyImported).map((p) => p.ref)))
  }, [])

  useEffect(() => {
    void (async () => {
      const found = await window.api.library.findPioneerUsb()
      if (found) await load(found)
    })()
  }, [load])

  const browse = async (): Promise<void> => {
    const root = await window.api.library.browseForUsb()
    if (root) await load(root)
  }
  const toggle = (ref: string): void =>
    setSelected((s) => { const n = new Set(s); n.has(ref) ? n.delete(ref) : n.add(ref); return n })
  const doImport = async (): Promise<void> => {
    if (!usbRoot || selected.size === 0) return
    setBusy(true)
    const res = await window.api.setHistory.importUsb(usbRoot, [...selected])
    setBusy(false)
    if ('error' in res) { setError(res.error); return }
    onImported()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-chassis border border-border/40 rounded-lg w-[540px] max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-ink"><span className="text-accent mr-1.5">⟱</span>Import from USB</p>
          <button onClick={onClose} className="text-muted/50 hover:text-muted text-sm">✕</button>
        </div>

        <div className="px-4 py-3 overflow-y-auto">
          {usbRoot && <p className="font-mono text-[10px] text-muted/60 mb-2 truncate">{usbRoot}</p>}
          {error && <p className="font-mono text-[11px] text-rec mb-2">⚠ {error}</p>}

          {!previews && !error && (
            <div className="py-6 text-center">
              <p className="font-mono text-[12px] text-muted mb-3">{usbRoot ? 'Reading HISTORY…' : 'Looking for a Pioneer stick…'}</p>
              <button onClick={browse} className="font-mono text-[11px] text-accent border border-accent/40 rounded px-3 py-1.5 hover:bg-accent/[0.08]">Browse for USB…</button>
            </div>
          )}

          {previews && previews.length === 0 && (
            <p className="font-mono text-[12px] text-muted/70 py-4">No HISTORY sets found on this stick.</p>
          )}

          {previews && previews.map((p) => (
            <label key={p.ref} className={`flex items-center gap-3 px-2 py-2 rounded border-b border-border/15 ${p.alreadyImported ? 'opacity-50' : 'cursor-pointer hover:bg-ink/[0.04]'}`}>
              <input type="checkbox" disabled={p.alreadyImported} checked={selected.has(p.ref)} onChange={() => toggle(p.ref)} />
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[12px] text-ink truncate">{p.name}</p>
                <p className="font-mono text-[10px] text-muted/70">
                  {fmtDate(p.playedOn)} · {p.trackCount} trks{p.matchedCount < p.trackCount ? ` (${p.matchedCount} matched)` : ''} · {mmss(p.durationSec)}
                </p>
              </div>
              <span className={`font-mono text-[9px] uppercase tracking-wider ${p.alreadyImported ? 'text-muted/50' : 'text-[#6E8059]'}`}>
                {p.alreadyImported ? 'imported' : 'new'}
              </span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-border/30">
          <button onClick={browse} className="font-mono text-[11px] text-muted hover:text-ink">Change USB…</button>
          <button
            onClick={doImport}
            disabled={busy || selected.size === 0}
            className={`font-mono text-[11px] rounded px-3 py-1.5 ${busy || selected.size === 0 ? 'text-muted/40 border border-border/30' : 'text-bg bg-accent hover:opacity-90'}`}
          >{busy ? 'Importing…' : `Import ${selected.size || ''}`}</button>
        </div>
      </div>
    </div>
  )
}

const CMP_ROWS: { label: string; get: (s: SetCompareSide) => number | null; fmt: (v: number) => string }[] = [
  { label: 'Tracks', get: (s) => s.trackCount, fmt: (v) => `${v}` },
  { label: 'Length', get: (s) => s.durationSec, fmt: (v) => mmss(v) },
  { label: 'Tracks / hr', get: (s) => s.tracksPerHour, fmt: (v) => v.toFixed(1) },
  { label: 'Avg BPM', get: (s) => s.avgBpm, fmt: (v) => `${Math.round(v)}` },
  { label: 'BPM range', get: (s) => s.bpmRange, fmt: (v) => `${Math.round(v)}` },
  { label: 'Energy', get: (s) => s.energyAvg, fmt: (v) => v.toFixed(1) },
  { label: 'Harmonic %', get: (s) => s.harmonicPct, fmt: (v) => `${Math.round(v)}%` },
  { label: 'Key diversity', get: (s) => s.keyDiversityPct, fmt: (v) => `${Math.round(v)}%` },
  { label: 'Rough cuts', get: (s) => s.roughTransitions, fmt: (v) => `${v}` }
]

function CompareModal({ aId, sets, onClose }: { aId: string; sets: SetSummary[]; onClose: () => void }): JSX.Element {
  const aIdx = sets.findIndex((s) => s.id === aId)
  const others = sets.filter((s) => s.id !== aId)
  const [bId, setBId] = useState<string | null>(sets[aIdx + 1]?.id ?? others[0]?.id ?? null)
  const [cmp, setCmp] = useState<SetComparison | null>(null)
  useEffect(() => {
    if (!bId) { setCmp(null); return }
    let live = true
    void window.api.setHistory.compare(aId, bId).then((c) => { if (live) setCmp(c) })
    return () => { live = false }
  }, [aId, bId])

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-chassis border border-border/40 rounded-lg w-[640px] max-h-[82vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-ink"><span className="text-accent mr-1.5">⇄</span>Compare sets</p>
          <button onClick={onClose} className="text-muted/50 hover:text-muted text-sm">✕</button>
        </div>
        <div className="px-4 py-3 overflow-y-auto">
          {!cmp ? <p className="font-mono text-[12px] text-muted py-4">{bId ? 'Comparing…' : 'No other set to compare against.'}</p> : (
            <>
              {/* column headers + B picker */}
              <div className="grid grid-cols-[1.4fr_1fr_1fr_0.8fr] gap-2 items-end pb-2 border-b border-border/30">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">metric</span>
                <span className="font-mono text-[11px] text-ink truncate" title={cmp.a.title}>{cmp.a.title}</span>
                <select value={bId ?? ''} onChange={(e) => setBId(e.target.value)} className="font-mono text-[11px] bg-paper border border-border/40 rounded px-1 py-0.5 text-ink min-w-0">
                  {others.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted text-right">Δ</span>
              </div>
              {CMP_ROWS.map((r) => {
                const da = r.get(cmp.a); const dbv = r.get(cmp.b)
                const d = da != null && dbv != null ? da - dbv : null
                return (
                  <div key={r.label} className="grid grid-cols-[1.4fr_1fr_1fr_0.8fr] gap-2 py-1 border-b border-border/15 font-mono text-[12px]">
                    <span className="text-muted">{r.label}</span>
                    <span className="text-ink tabular-nums">{da != null ? r.fmt(da) : '—'}</span>
                    <span className="text-ink tabular-nums">{dbv != null ? r.fmt(dbv) : '—'}</span>
                    <span className={`tabular-nums text-right ${d == null || d === 0 ? 'text-muted/50' : d > 0 ? 'text-[#6E8059]' : 'text-[#B86E72]'}`}>
                      {d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${r.fmt(Math.abs(d))}`}
                    </span>
                  </div>
                )
              })}
              {/* track overlap */}
              <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
                <span className="text-ink"><b className="tabular-nums">{cmp.shared.length}</b> <span className="text-muted">shared</span></span>
                <span className="text-ink"><b className="tabular-nums">{cmp.onlyA.length}</b> <span className="text-muted">only ◀ A</span></span>
                <span className="text-ink"><b className="tabular-nums">{cmp.onlyB.length}</b> <span className="text-muted">only B ▶</span></span>
              </div>
              {cmp.shared.length > 0 && (
                <p className="font-mono text-[10px] text-muted/70 mt-2 leading-relaxed">
                  Shared: {cmp.shared.slice(0, 8).map((t) => t.title).join(', ')}{cmp.shared.length > 8 ? ` +${cmp.shared.length - 8}` : ''}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`font-mono text-[11px] px-2.5 py-1 rounded-full border transition-colors ${active ? 'border-accent text-ink bg-accent/[0.12]' : 'border-border/40 text-muted hover:text-ink'}`}
    >
      {color && <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: color }} />}
      {children}
    </button>
  )
}

function ResidencyPanel({ d }: { d: ResidencyDashboard }): JSX.Element {
  const { rollup, rotation } = d
  return (
    <div className="mx-5 mt-3 shrink-0 rounded border border-border/30 bg-paper/40 px-4 py-3">
      <div className="flex items-center gap-5 flex-wrap font-mono text-[11px]">
        <span className="text-ink font-bold">{d.residency.name}</span>
        <RollStat label="sets" value={`${rollup.setCount}`} />
        <RollStat label="avg bpm" value={rollup.avgBpm != null ? `${Math.round(rollup.avgBpm)}` : '—'} />
        <RollStat label="avg len" value={mmss(rollup.avgDurationSec)} />
        <RollStat label="avg harmonic" value={rollup.avgHarmonicPct != null ? `${Math.round(rollup.avgHarmonicPct)}%` : '—'} />
        <RollStat label="span" value={rollup.firstPlayedOn ? `${fmtDate(rollup.firstPlayedOn)} → ${fmtDate(rollup.lastPlayedOn)}` : '—'} />
      </div>
      {rotation.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted mb-1.5">Rotation · most-played here</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {rotation.slice(0, 12).map((t) => (
              <div key={t.trackId} className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-muted/60 tabular-nums w-6 text-right">{t.plays}×</span>
                <span className="text-ink truncate flex-1">{t.title}<span className="text-muted/60"> — {t.artist}</span></span>
                {t.streak >= 2 && <span className="text-rec text-[9px] shrink-0" title="played consecutively — consider resting">{t.streak} in a row</span>}
                {t.streak < 2 && t.lastAgo >= 3 && <span className="text-[#6E8059] text-[9px] shrink-0" title="not aired recently">rested {t.lastAgo}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
function RollStat({ label, value }: { label: string; value: string }): JSX.Element {
  return <span className="text-muted"><span className="text-ink font-bold tabular-nums">{value}</span> {label}</span>
}

function SetDetailPane({
  detail,
  residencies,
  onPatch,
  onDelete,
  onCompare
}: {
  detail: SetDetail
  residencies: Residency[]
  onPatch: (p: Partial<SetDetail>) => void
  onDelete: () => void
  onCompare: () => void
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
            <button onClick={onCompare} className="font-mono text-[11px] text-accent border border-accent/40 rounded px-2 py-1 hover:bg-accent/[0.08]">Compare</button>
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
        <select
          value={detail.residencyId ?? ''}
          onChange={(e) => onPatch({ residencyId: e.target.value || null })}
          className="font-mono text-[12px] bg-paper border border-border/40 rounded px-2 py-1 text-ink"
        >
          <option value="">No residency</option>
          {residencies.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
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
