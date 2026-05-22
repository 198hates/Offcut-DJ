/**
 * Library Health — maintenance and diagnostics.
 * 01 · Library stats
 * 02 · Duplicate scanner
 * 03 · Missing file scanner
 * 04 · Play history
 * 05 · Auto group (DBSCAN clustering)
 */
import { useState, useCallback, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { dbscan, clusterName, clusterKeyLabel } from '../../lib/clustering'
import type { Track, Playlist } from '@shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (!total) return ''
  return `${Math.round((n / total) * 100)}%`
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

type DuplicateGroup = Track[]

function scanForDuplicates(tracks: Track[]): DuplicateGroup[] {
  const byMeta = new Map<string, Track[]>()
  for (const track of tracks) {
    const key = `${normalize(track.artist)}||${normalize(track.title)}`
    if (!key.startsWith('||') && key !== '||') {
      if (!byMeta.has(key)) byMeta.set(key, [])
      byMeta.get(key)!.push(track)
    }
  }
  const alreadyGrouped = new Set<string>()
  const primaryGroups = [...byMeta.values()].filter((g) => g.length > 1)
  for (const g of primaryGroups) for (const t of g) alreadyGrouped.add(t.id)

  const byBpmDuration = new Map<string, Track[]>()
  for (const track of tracks) {
    if (alreadyGrouped.has(track.id) || !track.bpm || !track.durationSeconds) continue
    const dKey = `${Math.round(track.durationSeconds)}|${Math.round(track.bpm * 2) / 2}`
    if (!byBpmDuration.has(dKey)) byBpmDuration.set(dKey, [])
    byBpmDuration.get(dKey)!.push(track)
  }
  return [...primaryGroups, ...[...byBpmDuration.values()].filter((g) => g.length > 1)]
}

function trackScore(t: Track): number {
  return (
    (t.bpm != null ? 2 : 0) + (t.key ? 2 : 0) + (t.cuePoints.length > 0 ? 3 : 0) +
    (t.rating > 0 ? 1 : 0) + (t.comment ? 1 : 0) + (t.tags.length > 0 ? 1 : 0) +
    (t.durationSeconds != null ? 1 : 0)
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-ink/[0.03] border border-border/25 rounded p-3 space-y-0.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className="font-mono text-lg font-bold tabular-nums text-ink">{value}</p>
      {sub && <p className="font-mono text-[9px] text-muted/70">{sub}</p>}
    </div>
  )
}

// ── Library Stats ─────────────────────────────────────────────────────────────

function StatsSection({ tracks }: { tracks: Track[] }): JSX.Element {
  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
        <span className="text-accent mr-1.5">01</span>library stats
      </h2>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="total tracks" value={tracks.length.toLocaleString()} />
        <StatCard label="with bpm"   value={tracks.filter((t) => t.bpm != null).length.toLocaleString()} sub={pct(tracks.filter((t) => t.bpm != null).length, tracks.length)} />
        <StatCard label="with key"   value={tracks.filter((t) => t.key).length.toLocaleString()} sub={pct(tracks.filter((t) => t.key).length, tracks.length)} />
        <StatCard label="with cues"  value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.cuePoints.length > 0).length, tracks.length)} />
        <StatCard label="rated"      value={tracks.filter((t) => t.rating > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.rating > 0).length, tracks.length)} />
        <StatCard label="tagged"     value={tracks.filter((t) => t.tags.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.tags.length > 0).length, tracks.length)} />
      </div>
    </section>
  )
}

// ── Duplicate Scanner ─────────────────────────────────────────────────────────

function DuplicateGroupCard({ group, selected, playlists, onToggle, onSelectExtras }: {
  group: Track[]; selected: Set<string>; playlists: Playlist[]
  onToggle: (id: string) => void; onSelectExtras: () => void
}): JSX.Element {
  const hasKept = group.some((t) => !selected.has(t.id))
  return (
    <div className="bg-ink/[0.03] border border-border/30 rounded overflow-hidden">
      <div className="px-3 py-2 bg-yellow-400/5 border-b border-border/20 flex items-center justify-between">
        <p className="font-mono text-[10px] text-yellow-600 dark:text-yellow-400 font-bold truncate">
          {group[0].artist} — {group[0].title || '(no title)'}
        </p>
        <button onClick={onSelectExtras}
          className="ml-3 shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors">
          select extras
        </button>
      </div>
      {group.map((track) => {
        const isSelected = selected.has(track.id)
        const membership = playlists.filter((p) => p.trackIds.includes(track.id))
        return (
          <div key={track.id}
            className={`flex items-start gap-3 px-3 py-2.5 border-b border-border/10 last:border-0 hover:bg-ink/5 ${isSelected ? 'bg-red-500/5' : ''}`}>
            <input type="checkbox" checked={isSelected} onChange={() => onToggle(track.id)} className="accent-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-sans text-xs text-ink-soft truncate">{track.filePath.split('/').pop()}</p>
              <p className="font-mono text-[9px] text-muted truncate">{track.filePath}</p>
              {membership.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  {isSelected ? (
                    hasKept
                      ? <span className="font-mono text-[8px] text-amber-500/90">↺ {membership.length} playlist{membership.length > 1 ? 's' : ''} · will replace with kept</span>
                      : <span className="font-mono text-[8px] text-red-400/80">✕ {membership.length} playlist{membership.length > 1 ? 's' : ''} · no kept version</span>
                  ) : (
                    membership.slice(0, 4).map((pl) => (
                      <span key={pl.id} className="font-mono text-[8px] text-muted/70 flex items-center gap-0.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: pl.color || '#8A8474' }} />
                        {pl.name.length > 18 ? pl.name.slice(0, 18) + '…' : pl.name}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-3 font-mono text-[10px] text-muted tabular-nums pt-0.5">
              {track.bpm != null && <span>{track.bpm.toFixed(1)}</span>}
              {track.durationSeconds != null && <span>{Math.floor(track.durationSeconds / 60)}:{String(Math.round(track.durationSeconds % 60)).padStart(2, '0')}</span>}
              {track.cuePoints.length > 0 && <span className="text-accent/70">{track.cuePoints.length} cues</span>}
              {track.beatgrid.length > 0 && <span className="text-teal-500/70">grid</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DuplicatesSection({ tracks, playlists, deleteTracks }: {
  tracks: Track[]; playlists: Playlist[]; deleteTracks: (ids: string[]) => Promise<void>
}): JSX.Element {
  const [dupes, setDupes]               = useState<DuplicateGroup[] | null>(null)
  const [scanning, setScanning]         = useState(false)
  const [selected, setSelected]         = useState(new Set<string>())

  const scan = useCallback(() => {
    setScanning(true)
    setTimeout(() => { setDupes(scanForDuplicates(tracks)); setSelected(new Set()); setScanning(false) }, 100)
  }, [tracks])

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectExtras = (group: DuplicateGroup) => {
    const keepId = [...group].sort((a, b) => trackScore(b) - trackScore(a))[0].id
    setSelected((prev) => { const n = new Set(prev); for (const t of group) if (t.id !== keepId) n.add(t.id); return n })
  }
  const selectAllExtras = () => {
    if (!dupes) return
    const next = new Set<string>()
    for (const group of dupes) {
      const sorted = [...group].sort((a, b) => trackScore(b) - trackScore(a))
      for (const t of sorted.slice(1)) next.add(t.id)
    }
    setSelected(next)
  }

  const deleteSelected = async () => {
    if (!dupes || !selected.size) return
    const keepMap = new Map<string, string>()
    for (const group of dupes) {
      const keepTrack = group.find((t) => !selected.has(t.id))
      if (keepTrack) for (const t of group) if (selected.has(t.id)) keepMap.set(t.id, keepTrack.id)
    }
    const nonSmartPlaylists = playlists.filter((p) => !p.isSmart)
    const inPlaylists = [...selected].filter((id) => nonSmartPlaylists.some((p) => p.trackIds.includes(id))).length
    const suffix = selected.size !== 1 ? 's' : ''
    const msg = inPlaylists > 0
      ? `Remove ${selected.size} track${suffix} from library?\n\n${inPlaylists} of them appear in playlists — they will be replaced with the kept version.`
      : `Remove ${selected.size} track${suffix} from library?`
    if (!window.confirm(msg)) return
    for (const [removeId, keepId] of keepMap) await window.api.library.replaceTrackInPlaylists(removeId, keepId)
    const toDelete = [...selected]
    await deleteTracks(toDelete)
    await useLibraryStore.getState().loadLibrary()
    const deletedSet = new Set(toDelete)
    setSelected(new Set())
    setDupes((prev) => prev?.map((g) => g.filter((t) => !deletedSet.has(t.id))).filter((g) => g.length > 1) ?? null)
  }

  const totalDupeCount = dupes?.reduce((s, g) => s + g.length, 0) ?? 0

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
            <span className="text-accent mr-1.5">02</span>duplicate tracks
          </h2>
          <p className="font-mono text-[10px] text-muted mt-0.5">matches by artist + title, and by duration + bpm</p>
        </div>
        <button onClick={scan} disabled={scanning || tracks.length === 0}
          className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors">
          {scanning ? 'scanning…' : dupes ? 're-scan' : 'scan for duplicates'}
        </button>
      </div>

      {dupes !== null && (
        dupes.length === 0 ? (
          <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> no duplicates found
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] text-ink-soft">
                found <span className="text-ink font-bold">{dupes.length}</span> group{dupes.length !== 1 ? 's' : ''}{' '}
                (<span className="text-ink font-bold">{totalDupeCount}</span> tracks total)
              </p>
              <div className="flex items-center gap-2">
                <button onClick={selectAllExtras}
                  className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 text-ink-soft hover:text-ink font-mono text-[10px] uppercase tracking-[0.1em] rounded transition-colors">
                  auto-select extras
                </button>
                {selected.size > 0 && (
                  <button onClick={deleteSelected}
                    className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors">
                    remove {selected.size} selected
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {dupes.map((group, gi) => (
                <DuplicateGroupCard key={gi} group={group} selected={selected} playlists={playlists.filter((p) => !p.isSmart)}
                  onToggle={toggle} onSelectExtras={() => selectExtras(group)} />
              ))}
            </div>
          </div>
        )
      )}
    </section>
  )
}

// ── Missing File Scanner ──────────────────────────────────────────────────────

function MissingFilesSection({ deleteTracks, updateTrack }: {
  deleteTracks: (ids: string[]) => Promise<void>
  updateTrack: (patch: Partial<Track> & { id: string }) => Promise<void>
}): JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const [missing, setMissing]     = useState<Track[] | null>(null)
  const [scanning, setScanning]   = useState(false)
  const [locating, setLocating]   = useState(false)
  const [locateResult, setLocateResult] = useState<{ found: number; total: number } | null>(null)

  const scan = useCallback(async () => {
    setScanning(true)
    const result = await window.api.library.scanMissingFiles()
    setMissing(result)
    setScanning(false)
  }, [])

  const autoLocate = async () => {
    if (!missing?.length) return
    setLocating(true)
    setLocateResult(null)
    const results = await window.api.library.autoLocateMissing()
    setLocating(false)
    if (!results.length) { setLocateResult({ found: 0, total: missing.length }); return }
    const foundIds = new Set(results.map((r) => r.trackId))
    await useLibraryStore.getState().loadLibrary()
    setMissing((prev) => prev?.filter((t) => !foundIds.has(t.id)) ?? null)
    setLocateResult({ found: results.length, total: missing.length })
  }

  const locateTrack = async (track: Track) => {
    const p = await window.api.settings.choosePath(`Locate: ${track.title || track.filePath}`, false)
    if (!p) return
    await updateTrack({ id: track.id, filePath: p })
    setMissing((prev) => prev?.filter((t) => t.id !== track.id) ?? null)
  }

  const deleteAllMissing = async () => {
    if (!missing?.length) return
    if (!window.confirm(`Remove all ${missing.length} missing file${missing.length !== 1 ? 's' : ''} from library?`)) return
    await deleteTracks(missing.map((t) => t.id))
    setMissing([])
  }

  const deleteMissing = async (id: string) => {
    await deleteTracks([id])
    setMissing((prev) => prev?.filter((t) => t.id !== id) ?? null)
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
            <span className="text-accent mr-1.5">03</span>missing files
          </h2>
          <p className="font-mono text-[10px] text-muted mt-0.5">checks which tracks can no longer be found on disk</p>
        </div>
        <button onClick={scan} disabled={scanning || tracks.length === 0}
          className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[10px] uppercase tracking-[0.12em] rounded transition-colors">
          {scanning ? 'scanning…' : 'scan for missing files'}
        </button>
      </div>

      {missing !== null && (
        missing.length === 0 ? (
          <p className="font-mono text-[10px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> all {tracks.length.toLocaleString()} files found
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="font-mono text-[10px] text-ink-soft">
                <span className="text-red-500 font-bold">{missing.length}</span> missing file{missing.length !== 1 ? 's' : ''}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={autoLocate} disabled={locating}
                  className="px-3 py-1.5 bg-accent/10 hover:bg-accent/20 text-accent font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-accent/25 transition-colors disabled:opacity-40">
                  {locating ? 'searching…' : 'auto-locate'}
                </button>
                <button onClick={deleteAllMissing}
                  className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[10px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors">
                  remove all
                </button>
              </div>
            </div>
            {locateResult && (
              <p className={`font-mono text-[10px] ${locateResult.found > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted'}`}>
                {locateResult.found > 0 ? `✓ relocated ${locateResult.found} of ${locateResult.total} files` : 'no matching files found'}
              </p>
            )}
            <div className="space-y-1">
              {missing.map((track) => (
                <div key={track.id} className="flex items-center gap-3 py-2 px-3 bg-red-600/5 border border-red-600/15 rounded">
                  <div className="flex-1 min-w-0">
                    <p className="font-sans text-xs text-ink truncate">{track.title || 'Unknown'}</p>
                    <p className="font-mono text-[9px] text-muted truncate">{track.filePath}</p>
                  </div>
                  <button onClick={() => locateTrack(track)}
                    className="shrink-0 px-2 py-1 font-mono text-[9px] text-muted/70 hover:text-accent border border-border/30 rounded transition-colors">
                    locate
                  </button>
                  <button onClick={() => deleteMissing(track.id)}
                    className="shrink-0 font-mono text-[9px] text-red-400/60 hover:text-red-500 transition-colors">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </section>
  )
}

// ── Calendar Heatmap ──────────────────────────────────────────────────────────

const DAY_LABELS = ['Mon', 'Wed', 'Fri']
const DAY_OFFSETS = [1, 3, 5] // Mon=1 Wed=3 Fri=5 in getDay (Sun=0)

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function CalendarHeatmap(): JSX.Element {
  const [data, setData] = useState<{ day: string; count: number }[]>([])
  const [hoveredDay, setHoveredDay] = useState<{ day: string; count: number } | null>(null)

  useEffect(() => {
    window.api.library.getPlayHistory(52).then(setData)
  }, [])

  // Build a 52×7 grid starting from today going back 364 days
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Find the start of the first displayed week (Monday 52 weeks ago)
  const start = new Date(today)
  start.setDate(start.getDate() - 364)
  // Align to Monday
  const dow = start.getDay() // 0=Sun
  const daysToMon = (dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow)
  start.setDate(start.getDate() + daysToMon)

  const countMap = new Map(data.map((d) => [d.day, d.count]))
  const totalInPeriod = data.reduce((s, d) => s + d.count, 0)
  const maxCount = data.reduce((m, d) => Math.max(m, d.count), 0)

  // Build weeks array
  const weeks: { date: Date; iso: string; count: number }[][] = []
  const cur = new Date(start)
  for (let w = 0; w < 52; w++) {
    const week: { date: Date; iso: string; count: number }[] = []
    for (let d = 0; d < 7; d++) {
      const iso = cur.toISOString().slice(0, 10)
      week.push({ date: new Date(cur), iso, count: countMap.get(iso) ?? 0 })
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(week)
  }

  // Month labels — find which week each month first appears in
  const monthLabels: { week: number; label: string }[] = []
  let lastMonth = -1
  weeks.forEach((week, wi) => {
    const m = week[0].date.getMonth()
    if (m !== lastMonth) { monthLabels.push({ week: wi, label: MONTHS[m] }); lastMonth = m }
  })

  // Color cell by intensity — 0 = almost invisible, max = full accent
  const cellColor = (count: number): string => {
    if (count === 0) return 'rgb(var(--ink-rgb) / 0.06)'
    const t = maxCount > 0 ? Math.min(1, count / maxCount) : 0
    const alpha = 0.25 + t * 0.75
    return `rgba(216,106,74,${alpha.toFixed(2)})`
  }

  const CELL = 10  // px per cell
  const GAP  = 2   // px gap

  return (
    <div className="space-y-2">
      {/* Month labels row */}
      <div className="flex" style={{ marginLeft: 28, gap: GAP }}>
        {weeks.map((_, wi) => {
          const lbl = monthLabels.find((m) => m.week === wi)
          return (
            <div key={wi} style={{ width: CELL, flexShrink: 0 }}>
              {lbl && <span className="font-mono text-[8px] text-muted/60">{lbl.label}</span>}
            </div>
          )
        })}
      </div>

      {/* Grid */}
      <div className="flex gap-1">
        {/* Day-of-week labels */}
        <div className="flex flex-col justify-between" style={{ width: 22, gap: GAP }}>
          {Array.from({ length: 7 }, (_, di) => {
            const idx = DAY_OFFSETS.indexOf(di + 1)
            return (
              <div key={di} style={{ height: CELL, lineHeight: `${CELL}px` }}
                className="font-mono text-[8px] text-muted/50 text-right pr-1">
                {idx >= 0 ? DAY_LABELS[idx] : ''}
              </div>
            )
          })}
        </div>

        {/* Weeks */}
        <div className="flex" style={{ gap: GAP }}>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
              {week.map((cell) => {
                const isFuture = cell.date > today
                return (
                  <div
                    key={cell.iso}
                    style={{
                      width: CELL, height: CELL,
                      background: isFuture ? 'transparent' : cellColor(cell.count),
                      borderRadius: 2,
                      cursor: cell.count > 0 ? 'default' : 'default',
                      opacity: isFuture ? 0 : 1,
                    }}
                    onMouseEnter={() => !isFuture && setHoveredDay({ day: cell.iso, count: cell.count })}
                    onMouseLeave={() => setHoveredDay(null)}
                    title={isFuture ? '' : `${cell.iso}: ${cell.count} play${cell.count !== 1 ? 's' : ''}`}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Footer: legend + summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[8px] text-muted/50">less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <div key={t} style={{ width: 9, height: 9, borderRadius: 2, background: t === 0 ? 'rgb(var(--ink-rgb) / 0.06)' : `rgba(216,106,74,${0.25 + t * 0.75})` }} />
          ))}
          <span className="font-mono text-[8px] text-muted/50">more</span>
        </div>
        <div className="flex items-center gap-3">
          {hoveredDay ? (
            <span className="font-mono text-[9px] text-muted">
              {hoveredDay.day} · {hoveredDay.count} play{hoveredDay.count !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="font-mono text-[9px] text-muted/60">
              {totalInPeriod} plays in last 52 weeks
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Play History ──────────────────────────────────────────────────────────────

function PlayHistorySection({ tracks }: { tracks: Track[] }): JSX.Element {
  const totalPlays  = tracks.reduce((s, t) => s + t.playCount, 0)
  const neverPlayed = tracks.filter((t) => t.playCount === 0).length
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const recentCount  = tracks.filter((t) => t.lastPlayedAt && t.lastPlayedAt >= sevenDaysAgo).length
  const topTracks    = [...tracks].filter((t) => t.playCount > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 10)
  const genreCounts  = new Map<string, number>()
  for (const t of tracks) if (t.genre && t.playCount > 0) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + t.playCount)
  const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
        <span className="text-accent mr-1.5">04</span>play history
      </h2>

      {/* Calendar heatmap */}
      <CalendarHeatmap />

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="total plays"    value={totalPlays.toLocaleString()} />
        <StatCard label="played last 7d" value={recentCount.toLocaleString()} sub={pct(recentCount, tracks.length)} />
        <StatCard label="never played"   value={neverPlayed.toLocaleString()} sub={pct(neverPlayed, tracks.length)} />
      </div>

      {topTracks.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">most played</p>
          <div className="space-y-1">
            {topTracks.map((t, i) => (
              <div key={t.id} className="flex items-center gap-3 py-1.5 px-3 bg-ink/[0.03] border border-border/20 rounded">
                <span className="font-mono text-[9px] text-muted/50 tabular-nums w-4 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[10px] text-ink truncate block">{t.title || '—'}</span>
                  <span className="font-mono text-[9px] text-muted truncate block">{t.artist}</span>
                </div>
                <span className="font-mono text-[10px] font-bold text-accent tabular-nums shrink-0">{t.playCount}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topGenres.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted">plays by genre</p>
          <div className="space-y-1.5">
            {topGenres.map(([genre, count]) => (
              <div key={genre} className="flex items-center gap-3">
                <span className="font-mono text-[10px] text-ink-soft w-32 truncate shrink-0">{genre}</span>
                <div className="flex-1 h-1.5 bg-ink/[0.07] rounded-full overflow-hidden">
                  <div className="h-full bg-accent/60 rounded-full transition-all" style={{ width: `${(count / topGenres[0][1]) * 100}%` }} />
                </div>
                <span className="font-mono text-[9px] text-muted tabular-nums w-8 text-right shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalPlays === 0 && (
        <p className="font-mono text-[10px] text-muted/50 italic">No plays recorded yet. Tracks you play are counted automatically.</p>
      )}
    </section>
  )
}

// ── Auto Group ────────────────────────────────────────────────────────────────

function AutoGroupSection({ tracks }: { tracks: Track[] }): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const [epsilon, setEpsilon] = useState(0.15)
  const [minPts,  setMinPts]  = useState(0)
  const [running, setRunning] = useState(false)
  const [preview, setPreview] = useState<{ name: string; count: number; keyLabel: string }[] | null>(null)
  const [noiseCount, setNoiseCount] = useState(0)
  const [saved,   setSaved]   = useState(false)

  const effectiveMinPts = minPts > 0 ? minPts : Math.max(5, Math.floor(tracks.length / 100))

  const run = useCallback(() => {
    setRunning(true)
    setSaved(false)
    setTimeout(() => {
      const { clusters, noise } = dbscan(tracks, epsilon, effectiveMinPts)
      setPreview(clusters.map((c) => ({ name: clusterName(c), count: c.length, keyLabel: clusterKeyLabel(c) })))
      setNoiseCount(noise.length)
      setRunning(false)
    }, 20)
  }, [tracks, epsilon, effectiveMinPts])

  const save = useCallback(async () => {
    if (!preview) return
    setRunning(true)
    const { clusters } = dbscan(tracks, epsilon, effectiveMinPts)
    await window.api.library.runAutoGroup(clusters.map((c) => ({ name: clusterName(c), trackIds: c.map((t) => t.id) })))
    await loadLibrary()
    setSaved(true)
    setRunning(false)
  }, [preview, tracks, epsilon, effectiveMinPts, loadLibrary])

  const eligible = tracks.filter((t) => t.bpm != null).length

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">
        <span className="text-accent mr-1.5">05</span>auto group
      </h2>
      <p className="font-mono text-[9.5px] text-muted/80 leading-relaxed">
        Clusters the library by BPM, key, and energy using DBSCAN. Creates non-destructive playlists
        under <span className="text-ink">Auto Groups</span> in the sidebar. Re-running replaces previous groups.
      </p>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">ε</label>
          <input type="range" min="0.05" max="0.40" step="0.01" value={epsilon}
            onChange={(e) => { setEpsilon(parseFloat(e.target.value)); setPreview(null) }}
            className="w-28 accent-accent" />
          <span className="font-mono text-[10px] text-ink tabular-nums w-8">{epsilon.toFixed(2)}</span>
          <span className="font-mono text-[9px] text-muted/60">{epsilon < 0.10 ? 'tight' : epsilon < 0.18 ? 'balanced' : 'broad'}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">min tracks</label>
          <input type="number" min="2" max="50" value={minPts || ''} placeholder={String(effectiveMinPts)}
            onChange={(e) => { setMinPts(parseInt(e.target.value) || 0); setPreview(null) }}
            className="w-16 bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent" />
        </div>
        <span className="font-mono text-[9px] text-muted/50">{eligible.toLocaleString()} of {tracks.length.toLocaleString()} tracks eligible</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={running || tracks.length === 0}
          className="px-4 py-2 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft hover:text-ink transition-colors disabled:opacity-40">
          {running ? 'running…' : 'preview groups'}
        </button>
        {preview && !saved && (
          <button onClick={save} disabled={running || preview.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-paper rounded font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40">
            save {preview.length} groups to library
          </button>
        )}
        {saved && <span className="font-mono text-[10px] text-green-600 dark:text-green-400">✓ Groups saved — check Auto Groups in the sidebar</span>}
      </div>
      {preview && (
        <div className="space-y-2">
          <p className="font-mono text-[9px] text-muted uppercase tracking-[0.12em]">{preview.length} groups · {noiseCount} ungrouped</p>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {preview.map((g, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 px-3 bg-ink/[0.03] border border-border/25 rounded">
                <span className="font-mono text-[9px] text-muted/50 tabular-nums w-5 text-right shrink-0">{i + 1}</span>
                <span className="flex-1 font-mono text-[10px] text-ink truncate">{g.name}</span>
                {g.keyLabel && <span className="font-mono text-[9px] text-muted shrink-0">{g.keyLabel}</span>}
                <span className="font-mono text-[10px] font-bold text-accent tabular-nums shrink-0">{g.count}</span>
              </div>
            ))}
          </div>
          {preview.length === 0 && <p className="font-mono text-[9.5px] text-muted/60 italic">No groups found — try raising ε or lowering min tracks</p>}
        </div>
      )}
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function HealthPage(): JSX.Element {
  const { tracks, playlists, deleteTracks, updateTrack } = useLibraryStore()

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-3xl">
      <div>
        <h1 className="text-base font-mono font-bold uppercase tracking-[0.12em] text-ink mb-0.5">
          <span className="text-accent mr-2">⟳</span>library health
        </h1>
        <p className="font-mono text-xs text-muted">scan for issues, find duplicates, track missing files</p>
      </div>

      <StatsSection tracks={tracks} />
      <div className="border-t border-border/20" />
      <DuplicatesSection tracks={tracks} playlists={playlists} deleteTracks={deleteTracks} />
      <div className="border-t border-border/20" />
      <MissingFilesSection deleteTracks={deleteTracks} updateTrack={updateTrack} />
      <div className="border-t border-border/20" />
      <PlayHistorySection tracks={tracks} />
      <div className="border-t border-border/20" />
      <AutoGroupSection tracks={tracks} />
    </div>
  )
}
