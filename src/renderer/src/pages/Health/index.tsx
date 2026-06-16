/**
 * Library Health — maintenance and diagnostics. A pinned stats overview plus
 * tabbed tools: duplicates, missing files, play history, genre playlists, backup.
 */
import { useState, useCallback, useEffect } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import { PageHeader } from '../../components/PageHeader'
import { StatCard } from '../../components/StatCard'
import { tabClass, btnGhost, btnPrimary } from '../../lib/ui'
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

/** Raw cosine of two equal-length vectors. Identical audio → ~1.0. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const den = Math.sqrt(na) * Math.sqrt(nb)
  return den ? dot / den : 0
}

/**
 * Group tracks by AUDIO content (Phase-2 embeddings) — catches re-tagged /
 * re-encoded copies that metadata misses. Duration-bucketed to stay near-linear;
 * a high cosine threshold (+ tight duration match) keeps false positives down.
 */
function scanAudioDuplicates(tracks: Track[], skip: Set<string>): DuplicateGroup[] {
  const cands = tracks.filter((t) => !skip.has(t.id) && t.embedding && t.durationSeconds)
  const buckets = new Map<number, Track[]>()
  for (const t of cands) {
    const k = Math.round(t.durationSeconds! / 3) // ~3s buckets
    for (const kk of [k - 1, k, k + 1]) { if (!buckets.has(kk)) buckets.set(kk, []); buckets.get(kk)!.push(t) }
  }
  const groups: DuplicateGroup[] = []
  const used = new Set<string>()
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i]
      if (used.has(a.id)) continue
      const group = [a]
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j]
        if (used.has(b.id)) continue
        const durRatio = Math.abs(a.durationSeconds! - b.durationSeconds!) / a.durationSeconds!
        if (durRatio < 0.03 && cosine(a.embedding!, b.embedding!) >= 0.995) group.push(b)
      }
      if (group.length > 1) { for (const t of group) used.add(t.id); groups.push(group) }
    }
  }
  return groups
}

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
  const bpmGroups = [...byBpmDuration.values()].filter((g) => g.length > 1)
  for (const g of bpmGroups) for (const t of g) alreadyGrouped.add(t.id)

  // Audio-content pass over anything not already grouped.
  const audioGroups = scanAudioDuplicates(tracks, alreadyGrouped)
  return [...primaryGroups, ...bpmGroups, ...audioGroups]
}

function trackScore(t: Track): number {
  return (
    (t.bpm != null ? 2 : 0) + (t.key ? 2 : 0) + (t.cuePoints.length > 0 ? 3 : 0) +
    (t.rating > 0 ? 1 : 0) + (t.comment ? 1 : 0) + (t.tags.length > 0 ? 1 : 0) +
    (t.durationSeconds != null ? 1 : 0)
  )
}

// ── Library Stats ─────────────────────────────────────────────────────────────

function StatsSection({ tracks }: { tracks: Track[] }): JSX.Element {
  const n = tracks.length
  const withBpm     = tracks.filter((t) => t.bpm != null).length
  const withKey     = tracks.filter((t) => t.key).length
  const withEnergy  = tracks.filter((t) => t.energy != null).length
  const withGenre   = tracks.filter((t) => t.genre?.trim()).length
  const withCues    = tracks.filter((t) => t.cuePoints.length > 0).length
  const withBeatgrid= tracks.filter((t) => t.analysedBeatgrid != null).length
  const needsAny    = tracks.filter((t) => !t.bpm || !t.key).length
  const rated       = tracks.filter((t) => t.rating > 0).length
  const tagged      = tracks.filter((t) => t.tags.length > 0).length

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">library stats
      </h2>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="total tracks" value={n.toLocaleString()} />
        <StatCard label="with bpm"     value={withBpm.toLocaleString()} sub={pct(withBpm, n)} />
        <StatCard label="with key"     value={withKey.toLocaleString()} sub={pct(withKey, n)} />
        <StatCard label="with energy"  value={withEnergy.toLocaleString()} sub={pct(withEnergy, n)} />
        <StatCard label="with genre"   value={withGenre.toLocaleString()} sub={pct(withGenre, n)} />
        <StatCard label="with cues"    value={withCues.toLocaleString()} sub={pct(withCues, n)} />
        <StatCard label="beatgrid v2"  value={withBeatgrid.toLocaleString()} sub={pct(withBeatgrid, n)} />
        <StatCard label="needs analysis" value={needsAny.toLocaleString()} sub={pct(needsAny, n)} accent={needsAny > 0} tone="amber" />
        <StatCard label="rated"        value={rated.toLocaleString()} sub={pct(rated, n)} />
        <StatCard label="tagged"       value={tagged.toLocaleString()} sub={pct(tagged, n)} />
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
  const openTrackMenu = useTrackMenuContext()
  return (
    <div className="bg-ink/[0.03] border border-border/30 rounded overflow-hidden">
      <div className="px-3 py-2 bg-yellow-400/5 border-b border-border/20 flex items-center justify-between">
        <p className="font-mono text-[13px] text-yellow-600 dark:text-yellow-400 font-bold truncate">
          {group[0].artist} — {group[0].title || '(no title)'}
        </p>
        <button onClick={onSelectExtras}
          className="ml-3 shrink-0 font-mono text-[12px] uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors">
          select extras
        </button>
      </div>
      {group.map((track) => {
        const isSelected = selected.has(track.id)
        const membership = playlists.filter((p) => p.trackIds.includes(track.id))
        return (
          <div key={track.id}
            onContextMenu={(e) => openTrackMenu(e, { ids: [track.id], track })}
            className={`flex items-start gap-3 px-3 py-2.5 border-b border-border/10 last:border-0 hover:bg-ink/5 ${isSelected ? 'bg-red-500/5' : ''}`}>
            <input type="checkbox" checked={isSelected} onChange={() => onToggle(track.id)} className="accent-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-sans text-xs text-ink-soft truncate">{track.filePath.split('/').pop()}</p>
              <p className="font-mono text-[12px] text-muted truncate">{track.filePath}</p>
              {membership.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  {isSelected ? (
                    hasKept
                      ? <span className="font-mono text-[11px] text-amber-500/90">↺ {membership.length} playlist{membership.length > 1 ? 's' : ''} · will replace with kept</span>
                      : <span className="font-mono text-[11px] text-red-400/80">✕ {membership.length} playlist{membership.length > 1 ? 's' : ''} · no kept version</span>
                  ) : (
                    membership.slice(0, 4).map((pl) => (
                      <span key={pl.id} className="font-mono text-[11px] text-muted/70 flex items-center gap-0.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: pl.color || '#8A8474' }} />
                        {pl.name.length > 18 ? pl.name.slice(0, 18) + '…' : pl.name}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-3 font-mono text-[13px] text-muted tabular-nums pt-0.5">
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
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">duplicate tracks
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">matches by artist + title, by duration + bpm, and by audio fingerprint (catches re-tags — needs Analyse → Audio similarity)</p>
        </div>
        <button onClick={scan} disabled={scanning || tracks.length === 0}
          className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
          {scanning ? 'scanning…' : dupes ? 're-scan' : 'scan for duplicates'}
        </button>
      </div>

      {dupes !== null && (
        dupes.length === 0 ? (
          <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> no duplicates found
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[13px] text-ink-soft">
                found <span className="text-ink font-bold">{dupes.length}</span> group{dupes.length !== 1 ? 's' : ''}{' '}
                (<span className="text-ink font-bold">{totalDupeCount}</span> tracks total)
              </p>
              <div className="flex items-center gap-2">
                <button onClick={selectAllExtras}
                  className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 text-ink-soft hover:text-ink font-mono text-[13px] uppercase tracking-[0.1em] rounded transition-colors">
                  auto-select extras
                </button>
                {selected.size > 0 && (
                  <button onClick={deleteSelected}
                    className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[13px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors">
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
  const openTrackMenu = useTrackMenuContext()
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
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">missing files
          </h2>
          <p className="font-mono text-[13px] text-muted mt-0.5">checks which tracks can no longer be found on disk</p>
        </div>
        <button onClick={scan} disabled={scanning || tracks.length === 0}
          className="px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.12em] rounded transition-colors">
          {scanning ? 'scanning…' : 'scan for missing files'}
        </button>
      </div>

      {missing !== null && (
        missing.length === 0 ? (
          <p className="font-mono text-[13px] text-green-600 dark:text-green-400 flex items-center gap-2">
            <span>✓</span> all {tracks.length.toLocaleString()} files found
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="font-mono text-[13px] text-ink-soft">
                <span className="text-red-500 font-bold">{missing.length}</span> missing file{missing.length !== 1 ? 's' : ''}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={autoLocate} disabled={locating}
                  className="px-3 py-1.5 bg-accent/10 hover:bg-accent/20 text-accent font-mono text-[13px] uppercase tracking-[0.1em] rounded border border-accent/25 transition-colors disabled:opacity-40">
                  {locating ? 'searching…' : 'auto-locate'}
                </button>
                <button onClick={deleteAllMissing}
                  className="px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-500 font-mono text-[13px] uppercase tracking-[0.1em] rounded border border-red-600/25 transition-colors">
                  remove all
                </button>
              </div>
            </div>
            {locateResult && (
              <p className={`font-mono text-[13px] ${locateResult.found > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted'}`}>
                {locateResult.found > 0 ? `✓ relocated ${locateResult.found} of ${locateResult.total} files` : 'no matching files found'}
              </p>
            )}
            <div className="space-y-1">
              {missing.map((track) => (
                <div key={track.id}
                  onContextMenu={(e) => openTrackMenu(e, { ids: [track.id], track })}
                  className="flex items-center gap-3 py-2 px-3 bg-red-600/5 border border-red-600/15 rounded">
                  <div className="flex-1 min-w-0">
                    <p className="font-sans text-xs text-ink truncate">{track.title || 'Unknown'}</p>
                    <p className="font-mono text-[12px] text-muted truncate">{track.filePath}</p>
                  </div>
                  <button onClick={() => locateTrack(track)}
                    className="shrink-0 px-2 py-1 font-mono text-[12px] text-muted/70 hover:text-accent border border-border/30 rounded transition-colors">
                    locate
                  </button>
                  <button onClick={() => deleteMissing(track.id)}
                    className="shrink-0 font-mono text-[12px] text-red-400/60 hover:text-red-500 transition-colors">
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
              {lbl && <span className="font-mono text-[11px] text-muted/60">{lbl.label}</span>}
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
                className="font-mono text-[11px] text-muted/50 text-right pr-1">
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
          <span className="font-mono text-[11px] text-muted/50">less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <div key={t} style={{ width: 9, height: 9, borderRadius: 2, background: t === 0 ? 'rgb(var(--ink-rgb) / 0.06)' : `rgba(216,106,74,${0.25 + t * 0.75})` }} />
          ))}
          <span className="font-mono text-[11px] text-muted/50">more</span>
        </div>
        <div className="flex items-center gap-3">
          {hoveredDay ? (
            <span className="font-mono text-[12px] text-muted">
              {hoveredDay.day} · {hoveredDay.count} play{hoveredDay.count !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="font-mono text-[12px] text-muted/60">
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
  const openTrackMenu = useTrackMenuContext()
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
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">play history
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
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">most played</p>
          <div className="space-y-1">
            {topTracks.map((t, i) => (
              <div key={t.id}
                onContextMenu={(e) => openTrackMenu(e, { ids: [t.id], track: t })}
                className="flex items-center gap-3 py-1.5 px-3 bg-ink/[0.03] border border-border/20 rounded">
                <span className="font-mono text-[12px] text-muted/50 tabular-nums w-4 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[13px] text-ink truncate block">{t.title || '—'}</span>
                  <span className="font-mono text-[12px] text-muted truncate block">{t.artist}</span>
                </div>
                <span className="font-mono text-[13px] font-bold text-accent tabular-nums shrink-0">{t.playCount}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topGenres.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">plays by genre</p>
          <div className="space-y-1.5">
            {topGenres.map(([genre, count]) => (
              <div key={genre} className="flex items-center gap-3">
                <span className="font-mono text-[13px] text-ink-soft w-32 truncate shrink-0">{genre}</span>
                <div className="flex-1 h-1.5 bg-ink/[0.07] rounded-full overflow-hidden">
                  <div className="h-full bg-accent/60 rounded-full transition-all" style={{ width: `${(count / topGenres[0][1]) * 100}%` }} />
                </div>
                <span className="font-mono text-[12px] text-muted tabular-nums w-8 text-right shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalPlays === 0 && (
        <p className="font-mono text-[13px] text-muted/50 italic">No plays recorded yet. Tracks you play are counted automatically.</p>
      )}
    </section>
  )
}

// ── Genre Playlists ────────────────────────────────────────────────────────────

function GenrePlaylistsSection({ tracks, playlists }: { tracks: Track[]; playlists: Playlist[] }): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const [running, setRunning] = useState(false)
  const [result, setResult]   = useState<{ created: number; updated: number } | null>(null)

  const genreCounts = new Map<string, number>()
  for (const t of tracks) {
    if (t.genre?.trim()) genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1)
  }
  const genres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1])

  const run = useCallback(async () => {
    setRunning(true)
    setResult(null)
    let created = 0, updated = 0
    for (const [genre, ] of genres) {
      const trackIds = tracks.filter((t) => t.genre === genre).map((t) => t.id)
      const existing = playlists.find((p) => p.name === genre && !p.isSmart && !p.isFolder)
      if (existing) {
        // Update: add any new tracks not already in the playlist
        const existingSet = new Set(existing.trackIds)
        const toAdd = trackIds.filter((id) => !existingSet.has(id))
        if (toAdd.length > 0) {
          await window.api.library.addTracksToPlaylist(existing.id, toAdd)
          updated++
        }
      } else {
        const pl = await window.api.library.createPlaylist(genre)
        await window.api.library.addTracksToPlaylist(pl.id, trackIds)
        created++
      }
    }
    await loadLibrary()
    setResult({ created, updated })
    setRunning(false)
  }, [genres, playlists, tracks, loadLibrary])

  return (
    <section className="space-y-4">
      <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">genre playlists
      </h2>
      <p className="font-mono text-[13px] text-muted/70">
        creates one playlist per genre from the tracks in your library — updates existing playlists if they already exist
      </p>

      {genres.length === 0 ? (
        <p className="font-mono text-[13px] text-muted/50 italic">no genre tags in library — run Smart Fixes → Suggest Genres first</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {genres.map(([g, c]) => (
              <span key={g} className="font-mono text-[11px] px-2 py-0.5 bg-ink/[0.05] border border-border/25 rounded">
                {g} <span className="text-muted/50">{c}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={run}
              disabled={running}
              className="font-mono text-[12px] uppercase tracking-[0.1em] px-4 py-1.5 rounded border transition-colors disabled:opacity-40
                border-accent/40 text-accent hover:bg-accent/[0.08]"
            >
              {running ? 'creating…' : `create ${genres.length} genre playlists`}
            </button>
            {result && (
              <span className="font-mono text-[12px] text-green-600 dark:text-green-400">
                ✓ {result.created} created · {result.updated} updated
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}

// ── Backup ─────────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function BackupSection({ tracks, playlists }: { tracks: Track[]; playlists: Playlist[] }): JSX.Element {
  const [backups, setBackups] = useState<import('@shared/types').BackupInfo[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => { window.api.backup.list().then(setBackups).catch(() => setBackups([])) }, [])
  useEffect(() => { refresh() }, [refresh])

  const snapshot = useCallback(async () => {
    setBusy(true)
    try { await window.api.backup.create() } finally { setBusy(false); refresh() }
  }, [refresh])

  const restore = useCallback(async (name: string) => {
    if (!window.confirm('Restore this snapshot? Your current library is snapshotted first, then the app relaunches.')) return
    await window.api.backup.restore(name) // relaunches; never returns
  }, [])

  const remove = useCallback(async (name: string) => {
    await window.api.backup.delete(name)
    refresh()
  }, [refresh])

  const exportJson = useCallback(() => {
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), trackCount: tracks.length, playlistCount: playlists.length, tracks, playlists }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `offcut-backup-${date}.json`; a.click()
    URL.revokeObjectURL(url)
  }, [tracks, playlists])

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-[0.12em] text-ink">backups</h2>
          <p className="font-mono text-[13px] text-muted/70 mt-0.5">
            restorable snapshots of your library DB (tracks · playlists · cues · grids). One is taken
            automatically before each import. Keeps the latest 20.
          </p>
        </div>
        <button onClick={snapshot} disabled={busy} className={btnPrimary}>
          {busy ? 'snapshotting…' : 'snapshot now'}
        </button>
      </div>

      {backups.length === 0 ? (
        <p className="font-mono text-[13px] text-muted/50 italic">no snapshots yet</p>
      ) : (
        <div className="border border-border/30 rounded divide-y divide-border/15 max-h-72 overflow-y-auto">
          {backups.map((b) => (
            <div key={b.name} className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[12px] text-ink tabular-nums">
                  {new Date(b.createdAt).toLocaleString()}
                  {b.label && <span className="text-muted/60 ml-2">· {b.label}</span>}
                </p>
                <p className="font-mono text-[11px] text-muted/50">{fmtBytes(b.sizeBytes)}</p>
              </div>
              <button onClick={() => restore(b.name)} className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent hover:text-ink border border-accent/30 hover:border-accent/60 rounded px-2 py-0.5 transition-colors">
                restore
              </button>
              <button onClick={() => remove(b.name)} title="Delete snapshot" className="text-muted/40 hover:text-red-500 transition-colors font-mono text-xs leading-none">×</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button onClick={exportJson} className={btnGhost}>export library as JSON</button>
        <span className="font-mono text-[12px] text-muted/40">portable metadata export (read-only)</span>
      </div>
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const HEALTH_TOOLS = [
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'missing', label: 'Missing files' },
  { id: 'history', label: 'Play history' },
  { id: 'genres', label: 'Genre playlists' },
  { id: 'backup', label: 'Backup' }
] as const
type HealthTool = (typeof HEALTH_TOOLS)[number]['id']

export function HealthPage(): JSX.Element {
  const { tracks, playlists, deleteTracks, updateTrack } = useLibraryStore()
  const [tool, setTool] = useState<HealthTool>('duplicates')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader marker="⟳" title="library health" subtitle="scan for issues, find duplicates, track missing files" />

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 max-w-3xl">
        {/* Pinned at-a-glance overview */}
        <StatsSection tracks={tracks} />

        {/* Tools — one at a time instead of a long stacked scroll */}
        <div className="flex flex-wrap gap-1 border-y border-border/20 py-2">
          {HEALTH_TOOLS.map((t) => (
            <button key={t.id} onClick={() => setTool(t.id)} className={tabClass(tool === t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tool === 'duplicates' && <DuplicatesSection tracks={tracks} playlists={playlists} deleteTracks={deleteTracks} />}
        {tool === 'missing' && <MissingFilesSection deleteTracks={deleteTracks} updateTrack={updateTrack} />}
        {tool === 'history' && <PlayHistorySection tracks={tracks} />}
        {tool === 'genres' && <GenrePlaylistsSection tracks={tracks} playlists={playlists} />}
        {tool === 'backup' && <BackupSection tracks={tracks} playlists={playlists} />}
      </div>
    </div>
  )
}
