import { useState, useCallback } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import type { Track } from '@shared/types'

type DuplicateGroup = Track[]
type MissingTrack = Track

export function LibraryHealthPage(): JSX.Element {
  const { tracks, deleteTracks } = useLibraryStore()
  const [dupes, setDupes] = useState<DuplicateGroup[] | null>(null)
  const [missing, setMissing] = useState<MissingTrack[] | null>(null)
  const [scanningDupes, setScanningDupes] = useState(false)
  const [scanningMissing, setScanningMissing] = useState(false)
  const [selectedDupes, setSelectedDupes] = useState<Set<string>>(new Set())

  const scanDuplicates = useCallback((): void => {
    setScanningDupes(true)
    setTimeout(() => {
      const groups: Map<string, Track[]> = new Map()
      for (const track of tracks) {
        const key = `${normalize(track.artist)}||${normalize(track.title)}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(track)
      }
      const found = [...groups.values()].filter((g) => g.length > 1)
      setDupes(found)
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

  const toggleDupeSelect = (id: string): void => {
    setSelectedDupes((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const deleteSelected = async (): Promise<void> => {
    if (!window.confirm(`Remove ${selectedDupes.size} track${selectedDupes.size !== 1 ? 's' : ''} from library?`)) return
    await deleteTracks([...selectedDupes])
    setSelectedDupes(new Set())
    setDupes((prev) =>
      prev
        ?.map((g) => g.filter((t) => !selectedDupes.has(t.id)))
        .filter((g) => g.length > 1) ?? null
    )
  }

  const deleteMissingTrack = async (id: string): Promise<void> => {
    await deleteTracks([id])
    setMissing((prev) => prev?.filter((t) => t.id !== id) ?? null)
  }

  const deleteAllMissing = async (): Promise<void> => {
    if (!missing?.length) return
    if (!window.confirm(`Remove all ${missing.length} missing track${missing.length !== 1 ? 's' : ''} from library?`)) return
    await deleteTracks(missing.map((t) => t.id))
    setMissing([])
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-white mb-1">Library Health</h1>
        <p className="text-sm text-white/40">Scan for issues and keep your library clean.</p>
      </div>

      {/* Duplicate Scanner */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Duplicate Tracks</h2>
            <p className="text-xs text-white/40 mt-0.5">Finds tracks with the same artist + title</p>
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
          <div>
            {dupes.length === 0 ? (
              <p className="text-sm text-green-400 flex items-center gap-2">
                <span>✓</span> No duplicates found
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-white/60">
                    Found <span className="text-white font-medium">{dupes.length}</span> duplicate group{dupes.length !== 1 ? 's' : ''}
                  </p>
                  {selectedDupes.size > 0 && (
                    <button
                      onClick={deleteSelected}
                      className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs rounded-lg border border-red-600/30 transition-colors"
                    >
                      Remove {selectedDupes.size} selected
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {dupes.map((group, gi) => (
                    <DuplicateGroup
                      key={gi}
                      group={group}
                      selected={selectedDupes}
                      onToggle={toggleDupeSelect}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="border-t border-white/5" />

      {/* Missing File Scanner */}
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
          <div>
            {missing.length === 0 ? (
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
                    <div
                      key={track.id}
                      className="flex items-center gap-3 py-2 px-3 bg-red-900/10 border border-red-900/20 rounded-lg"
                    >
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
            )}
          </div>
        )}
      </section>

      {/* Library Stats */}
      <div className="border-t border-white/5" />
      <section>
        <h2 className="text-sm font-semibold text-white mb-3">Library Stats</h2>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total Tracks" value={tracks.length.toLocaleString()} />
          <StatCard
            label="With BPM"
            value={tracks.filter((t) => t.bpm != null).length.toLocaleString()}
            sub={pct(tracks.filter((t) => t.bpm != null).length, tracks.length)}
          />
          <StatCard
            label="With Key"
            value={tracks.filter((t) => t.key).length.toLocaleString()}
            sub={pct(tracks.filter((t) => t.key).length, tracks.length)}
          />
          <StatCard
            label="With Cues"
            value={tracks.filter((t) => t.cuePoints.length > 0).length.toLocaleString()}
            sub={pct(tracks.filter((t) => t.cuePoints.length > 0).length, tracks.length)}
          />
          <StatCard
            label="Rated"
            value={tracks.filter((t) => t.rating > 0).length.toLocaleString()}
            sub={pct(tracks.filter((t) => t.rating > 0).length, tracks.length)}
          />
          <StatCard
            label="Tagged"
            value={tracks.filter((t) => t.tags.length > 0).length.toLocaleString()}
            sub={pct(tracks.filter((t) => t.tags.length > 0).length, tracks.length)}
          />
        </div>
      </section>
    </div>
  )
}

function DuplicateGroup({ group, selected, onToggle }: {
  group: Track[]
  selected: Set<string>
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-yellow-900/10 border-b border-white/5">
        <p className="text-xs text-yellow-400/80 font-medium">
          {group[0].artist} — {group[0].title}
        </p>
      </div>
      {group.map((track) => (
        <label key={track.id} className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.has(track.id)}
            onChange={() => onToggle(track.id)}
            className="accent-accent"
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white/70 truncate">{track.filePath.split('/').pop()}</p>
            <p className="text-xs text-white/30 truncate">{track.filePath}</p>
          </div>
          {track.bpm && <span className="text-xs text-white/40 tabular-nums shrink-0">{track.bpm.toFixed(1)}</span>}
        </label>
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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

function pct(n: number, total: number): string {
  if (!total) return ''
  return `${Math.round((n / total) * 100)}%`
}
