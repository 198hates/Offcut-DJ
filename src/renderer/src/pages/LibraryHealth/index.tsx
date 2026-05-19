import { useState, useCallback } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import type { Track } from '@shared/types'

type DuplicateGroup = Track[]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

function pct(n: number, total: number): string {
  if (!total) return ''
  return `${Math.round((n / total) * 100)}%`
}

function scanForDuplicates(tracks: Track[]): DuplicateGroup[] {
  // Primary match: same normalized artist + title
  const byMeta = new Map<string, Track[]>()
  for (const track of tracks) {
    const key = `${normalize(track.artist)}||${normalize(track.title)}`
    if (!key.startsWith('||') && key !== '||') {
      if (!byMeta.has(key)) byMeta.set(key, [])
      byMeta.get(key)!.push(track)
    }
  }

  // Secondary match: same duration (±1s) + same BPM (±0.5) for tracks without title matches
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
  const secondaryGroups = [...byBpmDuration.values()].filter((g) => g.length > 1)

  return [...primaryGroups, ...secondaryGroups]
}

// Score a track so the "best" copy has the highest score (more metadata = better)
function trackScore(t: Track): number {
  return (
    (t.bpm != null ? 2 : 0) +
    (t.key ? 2 : 0) +
    (t.cuePoints.length > 0 ? 3 : 0) +
    (t.rating > 0 ? 1 : 0) +
    (t.comment ? 1 : 0) +
    (t.tags.length > 0 ? 1 : 0) +
    (t.durationSeconds != null ? 1 : 0)
  )
}

export function LibraryHealthPage(): JSX.Element {
  const { tracks, deleteTracks } = useLibraryStore()
  const [dupes, setDupes] = useState<DuplicateGroup[] | null>(null)
  const [missing, setMissing] = useState<Track[] | null>(null)
  const [scanningDupes, setScanningDupes] = useState(false)
  const [scanningMissing, setScanningMissing] = useState(false)
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set())

  const scanDuplicates = useCallback((): void => {
    setScanningDupes(true)
    setTimeout(() => {
      setDupes(scanForDuplicates(tracks))
      setSelectedDupes(new Set())
      setScanningDupes(false)
    }, 100)
  }, [tracks])

  const scanMissing = useCallback(async (): Promise<void> => {
    setScanningMissing(true)
    const result = await window.api.library.scanMissingFiles()
    setMissing(result)
    setScanningMissing(false)
  }, [])

  const toggleDupe = (id: string): void =>
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Select all tracks in the group except the "best" one
  const selectExtras = (group: DuplicateGroup): void => {
    const sorted = [...group].sort((a, b) => trackScore(b) - trackScore(a))
    const keepId = sorted[0].id
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      for (const t of group) if (t.id !== keepId) next.add(t.id)
      return next
    })
  }

  // Keep only this track from its group; select all others
  const keepThis = (keepId: string, group: DuplicateGroup): void => {
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      for (const t of group) {
        if (t.id === keepId) next.delete(t.id)
        else next.add(t.id)
      }
      return next
    })
  }

  const selectAllExtras = (): void => {
    if (!dupes) return
    const next = new Set<string>()
    for (const group of dupes) {
      const sorted = [...group].sort((a, b) => trackScore(b) - trackScore(a))
      for (const t of sorted.slice(1)) next.add(t.id)
    }
    setSelectedDupes(next)
  }

  const deleteSelected = async (): Promise<void> => {
    if (!window.confirm(`Remove ${selectedDupes.size} track${selectedDupes.size !== 1 ? 's' : ''} from library?`)) return
    const toDelete = [...selectedDupes]
    await deleteTracks(toDelete)
    const deletedSet = new Set(toDelete)
    setSelectedDupes(new Set())
    setDupes((prev) =>
      prev?.map((g) => g.filter((t) => !deletedSet.has(t.id))).filter((g) => g.length > 1) ?? null
    )
  }

  const deleteMissingTrack = async (id: string): Promise<void> => {
    await deleteTracks([id])
    setMissing((prev) => prev?.filter((t) => t.id !== id) ?? null)
  }

  const deleteAllMissing = async (): Promise<void> => {
    if (!missing?.length) return
    if (!window.confirm(`Remove all ${missing.length} missing file${missing.length !== 1 ? 's' : ''} from library?`)) return
    await deleteTracks(missing.map((t) => t.id))
    setMissing([])
  }

  const totalDupeCount = dupes?.reduce((s, g) => s + g.length, 0) ?? 0

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold text-white mb-1">Library Health</h1>
        <p className="text-sm text-white/40">Scan for issues and keep your library clean.</p>
      </div>

      {/* ── Duplicate Scanner ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Duplicate Tracks</h2>
            <p className="text-xs text-white/40 mt-0.5">Matches on artist + title, then BPM + duration</p>
          </div>
          <button
            onClick={scanDuplicates}
            disabled={scanningDupes || tracks.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {scanningDupes ? 'Scanning…' : 'Scan for Duplicates'}
          </button>
        </div>

        {dupes !== null && (
          dupes.length === 0 ? (
            <p className="text-sm text-green-400 flex items-center gap-2"><span>✓</span> No duplicates found</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-white/60">
                  Found <span className="text-white font-medium">{dupes.length}</span> group{dupes.length !== 1 ? 's' : ''}{' '}
                  (<span className="text-white font-medium">{totalDupeCount}</span> tracks total)
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAllExtras}
                    className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-xs rounded-lg transition-colors"
                    title="Auto-select the lower-quality copy in each group"
                  >
                    Auto-select extras
                  </button>
                  {selectedDupes.size > 0 && (
                    <button
                      onClick={deleteSelected}
                      className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg border border-red-600/30 transition-colors"
                    >
                      Remove {selectedDupes.size} selected
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                {dupes.map((group, gi) => (
                  <DuplicateGroupCard
                    key={gi}
                    group={group}
                    selected={selectedDupes}
                    onToggle={toggleDupe}
                    onSelectExtras={() => selectExtras(group)}
                    onKeepThis={(id) => keepThis(id, group)}
                  />
                ))}
              </div>
            </div>
          )
        )}
      </section>

      <div className="border-t border-white/5" />

      {/* ── Missing File Scanner ──────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Missing Files</h2>
            <p className="text-xs text-white/40 mt-0.5">Checks which tracks can no longer be found on disk</p>
          </div>
          <button
            onClick={scanMissing}
            disabled={scanningMissing || tracks.length === 0}
            className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            {scanningMissing ? 'Scanning…' : 'Scan for Missing Files'}
          </button>
        </div>

        {missing !== null && (
          missing.length === 0 ? (
            <p className="text-sm text-green-400 flex items-center gap-2">
              <span>✓</span> All {tracks.length.toLocaleString()} files found
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-white/60">
                  <span className="text-red-400 font-medium">{missing.length}</span> missing file{missing.length !== 1 ? 's' : ''}
                </p>
                <button
                  onClick={deleteAllMissing}
                  className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg border border-red-600/30 transition-colors"
                >
                  Remove all from library
                </button>
              </div>
              <div className="space-y-1">
                {missing.map((track) => (
                  <div key={track.id} className="flex items-center gap-3 py-2 px-3 bg-red-900/10 border border-red-900/20 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{track.title || 'Unknown'}</p>
                      <p className="text-xs text-white/40 truncate">{track.filePath}</p>
                    </div>
                    <button
                      onClick={() => deleteMissingTrack(track.id)}
                      className="shrink-0 text-red-400/60 hover:text-red-400 text-xs transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </section>

      {/* ── Library Stats ─────────────────────────────────────────────────── */}
      <div className="border-t border-white/5" />
      <section>
        <h2 className="text-sm font-semibold text-white mb-3">Library Stats</h2>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total Tracks" value={tracks.length.toLocaleString()} />
          <StatCard label="With BPM" value={tracks.filter((t) => t.bpm != null).length.toLocaleString()} sub={pct(tracks.filter((t) => t.bpm != null).length, tracks.length)} />
          <StatCard label="With Key" value={tracks.filter((t) => t.key).length.toLocaleString()} sub={pct(tracks.filter((t) => t.key).length, tracks.length)} />
          <StatCard label="With Cues" value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.cuePoints.length > 0).length, tracks.length)} />
          <StatCard label="Rated" value={tracks.filter((t) => t.rating > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.rating > 0).length, tracks.length)} />
          <StatCard label="Tagged" value={tracks.filter((t) => t.tags.length > 0).length.toLocaleString()} sub={pct(tracks.filter((t) => t.tags.length > 0).length, tracks.length)} />
        </div>
      </section>
    </div>
  )
}

function DuplicateGroupCard({ group, selected, onToggle, onSelectExtras, onKeepThis }: {
  group: Track[]
  selected: Set<string>
  onToggle: (id: string) => void
  onSelectExtras: () => void
  onKeepThis: (id: string) => void
}): JSX.Element {
  const best = [...group].sort((a, b) => trackScore(b) - trackScore(a))[0]

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-yellow-900/10 border-b border-white/5 flex items-center justify-between">
        <p className="text-xs text-yellow-400/80 font-medium truncate">
          {group[0].artist} — {group[0].title || '(no title)'}
        </p>
        <button
          onClick={onSelectExtras}
          className="ml-3 shrink-0 text-xs text-white/30 hover:text-white/70 transition-colors"
          title="Select all except the best copy"
        >
          Select extras
        </button>
      </div>
      {group.map((track) => (
        <div key={track.id} className={`flex items-center gap-3 px-3 py-2 hover:bg-white/5 ${selected.has(track.id) ? 'bg-red-900/10' : ''}`}>
          <input
            type="checkbox"
            checked={selected.has(track.id)}
            onChange={() => onToggle(track.id)}
            className="accent-accent shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/70 truncate">{track.filePath.split('/').pop()}</p>
            <p className="text-xs text-white/30 truncate">{track.filePath}</p>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-xs text-white/40 tabular-nums">
            {track.bpm != null && <span>{track.bpm.toFixed(1)}</span>}
            {track.durationSeconds != null && (
              <span>{Math.floor(track.durationSeconds / 60)}:{String(Math.round(track.durationSeconds % 60)).padStart(2, '0')}</span>
            )}
            {track.cuePoints.length > 0 && <span className="text-accent/60">{track.cuePoints.length} cues</span>}
            {track.id === best.id && <span className="text-green-400/60 font-medium">best</span>}
          </div>
          <button
            onClick={() => onKeepThis(track.id)}
            className="shrink-0 text-xs text-white/20 hover:text-green-400 transition-colors"
            title="Keep this copy, select all others for deletion"
          >
            Keep
          </button>
        </div>
      ))}
    </div>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-lg px-4 py-3">
      <p className="text-xs text-white/40 mb-1">{label}</p>
      <p className="text-xl font-semibold text-white">{value}</p>
      {sub && <p className="text-xs text-white/30 mt-0.5">{sub}</p>}
    </div>
  )
}
