/**
 * RekordboxUsbPanel — read a prepared Rekordbox USB directly.
 *
 * Parses the stick's PIONEER/rekordbox/export.pdb (DeviceSQL — what the CDJs
 * read) and shows its playlist tree + tracks. Read-only for now (M0); writing
 * playlists back to USB is a later milestone.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { formatDuration, formatBpm } from '../lib/format'
import type { UsbExport, UsbPlaylistNode, UsbTrack } from '@shared/types'

/** Loose key for matching Offcut tracks to tracks already on the USB. */
function matchKey(artist: string, title: string): string {
  return `${artist} ${title}`
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

function PlaylistTree({
  nodes,
  depth,
  selectedId,
  onSelect
}: {
  nodes: UsbPlaylistNode[]
  depth: number
  selectedId: number | null
  onSelect: (n: UsbPlaylistNode) => void
}): JSX.Element {
  const [open, setOpen] = useState<Set<number>>(new Set())
  return (
    <>
      {nodes.map((n) => {
        const isOpen = open.has(n.id)
        return (
          <div key={n.id}>
            <button
              onClick={() => {
                if (n.isFolder) {
                  setOpen((s) => {
                    const next = new Set(s)
                    if (next.has(n.id)) next.delete(n.id)
                    else next.add(n.id)
                    return next
                  })
                } else {
                  onSelect(n)
                }
              }}
              className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left font-mono text-[12px] transition-colors ${
                selectedId === n.id ? 'bg-accent/15 text-ink' : 'text-ink-soft hover:bg-ink/[0.05]'
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <span className="shrink-0 opacity-70">{n.isFolder ? (isOpen ? '▾' : '▸') : '♪'}</span>
              <span className="truncate flex-1">{n.name}</span>
              {!n.isFolder && (
                <span className="shrink-0 text-muted/50 tabular-nums">{n.trackIds?.length ?? 0}</span>
              )}
            </button>
            {n.isFolder && isOpen && n.children && (
              <PlaylistTree nodes={n.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
            )}
          </div>
        )
      })}
    </>
  )
}

export function RekordboxUsbPanel(): JSX.Element {
  const [usbs, setUsbs] = useState<string[]>([])
  const [usbRoot, setUsbRoot] = useState<string | null>(null)
  const [data, setData] = useState<UsbExport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<UsbPlaylistNode | null>(null)

  // Send-to-USB (write) state.
  const playlists = useLibraryStore((s) => s.playlists)
  const libraryTracks = useLibraryStore((s) => s.tracks)
  const showToast = useToastStore((s) => s.show)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [writing, setWriting] = useState(false)
  const [progress, setProgress] = useState<{
    playlist: string; playlistIndex: number; playlistTotal: number
    track: string; trackIndex: number; trackTotal: number; action: 'link' | 'copy'
  } | null>(null)

  // Initialise-a-blank-USB state.
  const [initVolumes, setInitVolumes] = useState<{ root: string; name: string; hasRekordbox: boolean }[] | null>(null)
  const [initializing, setInitializing] = useState(false)

  const scan = useCallback(async () => {
    setError(null)
    const found = await window.api.rekordboxUsb.find()
    setUsbs(found)
    // Auto-select if exactly one is plugged in.
    if (found.length === 1 && !usbRoot) setUsbRoot(found[0])
  }, [usbRoot])

  useEffect(() => {
    void scan()
  }, [scan])

  const read = useCallback(async (root: string) => {
    setLoading(true)
    setError(null)
    setData(null)
    setSelected(null)
    const res = await window.api.rekordboxUsb.read(root)
    setLoading(false)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setData(res)
  }, [])

  useEffect(() => {
    if (usbRoot) void read(usbRoot)
  }, [usbRoot, read])

  const browse = useCallback(async () => {
    const root = await window.api.rekordboxUsb.browse()
    if (root) setUsbRoot(root)
  }, [])

  const openInit = useCallback(async () => {
    const vols = await window.api.rekordboxUsb.listVolumes()
    setInitVolumes(vols)
  }, [])

  const initVolume = useCallback(async (root: string) => {
    setInitializing(true)
    const res = await window.api.rekordboxUsb.initialize(root)
    setInitializing(false)
    if ('error' in res) {
      showToast(`Couldn't start USB: ${res.error}`, 'error')
      return
    }
    showToast('USB initialised — ready to sync playlists', 'success')
    setInitVolumes(null)
    await scan()
    setUsbRoot(root)
  }, [showToast, scan])

  const initBrowse = useCallback(async () => {
    const root = await window.api.rekordboxUsb.browse()
    if (root) await initVolume(root)
  }, [initVolume])

  const clearLoaded = useCallback(() => {
    setData(null)
    setSelected(null)
    setUsbRoot(null)
  }, [])

  const eject = useCallback(async () => {
    if (!usbRoot) return
    const res = await window.api.rekordboxUsb.eject(usbRoot)
    if ('error' in res) {
      showToast(`Couldn't eject: ${res.error}`, 'error')
      return
    }
    showToast('USB ejected — safe to remove', 'success')
    clearLoaded()
    await scan()
  }, [usbRoot, showToast, clearLoaded, scan])

  // React to volumes mounting/unmounting (e.g. ejected via Finder): rescan, and
  // if the loaded stick is gone, clear the view.
  useEffect(() => {
    const off = window.api.rekordboxUsb.onVolumesChanged(async () => {
      await scan()
      if (usbRoot) {
        const stillThere = await window.api.rekordboxUsb.exists(usbRoot)
        if (!stillThere) {
          clearLoaded()
          showToast('USB removed', 'info')
        }
      }
    })
    return off
  }, [usbRoot, scan, clearLoaded, showToast])

  const trackMap = new Map<number, UsbTrack>()
  if (data) for (const t of data.tracks) trackMap.set(t.id, t)
  const selectedTracks: UsbTrack[] = selected?.trackIds
    ? selected.trackIds.map((id) => trackMap.get(id)).filter((t): t is UsbTrack => !!t)
    : []

  // Index the USB's tracks by loose artist/title key, for matching.
  const usbIndex = useMemo(() => {
    const m = new Map<string, number>()
    if (data) for (const t of data.tracks) {
      const k = matchKey(t.artist, t.title)
      if (k && !m.has(k)) m.set(k, t.id)
    }
    return m
  }, [data])

  const libTrackById = useMemo(() => {
    const m = new Map<string, (typeof libraryTracks)[number]>()
    for (const t of libraryTracks) m.set(t.id, t)
    return m
  }, [libraryTracks])

  const syncablePlaylists = playlists.filter((p) => !p.isFolder && !p.isSmart)
  const selectedPlaylists = syncablePlaylists.filter((p) => selectedIds.has(p.id))

  // Aggregate preview across the selected playlists (unique tracks).
  const aggregate = useMemo(() => {
    if (!data || selectedPlaylists.length === 0) return { total: 0, onUsb: 0, toCopy: 0 }
    const seen = new Set<string>()
    let onUsb = 0
    let toCopy = 0
    for (const pl of selectedPlaylists) {
      for (const tid of pl.trackIds) {
        const t = libTrackById.get(tid)
        if (!t) continue
        const key = matchKey(t.artist, t.title)
        if (seen.has(key)) continue
        seen.add(key)
        if (usbIndex.get(key) != null) onUsb++
        else toCopy++
      }
    }
    return { total: seen.size, onUsb, toCopy }
  }, [data, selectedPlaylists, usbIndex, libTrackById])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Subscribe to per-track sync progress while a batch is running.
  useEffect(() => {
    const off = window.api.rekordboxUsb.onSyncProgress((p) => setProgress(p))
    return off
  }, [])

  const syncSelected = useCallback(async () => {
    if (!usbRoot || selectedPlaylists.length === 0) return
    setWriting(true)
    setProgress(null)
    const payload = selectedPlaylists.map((pl) => ({
      name: pl.name,
      tracks: pl.trackIds
        .map((id) => libTrackById.get(id))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => ({
          artist: t.artist,
          title: t.title,
          audioFilePath: t.filePath,
          bpm: t.bpm ?? 0,
          durationSec: Math.round(t.durationSeconds ?? 0),
          beatgrid: t.beatgrid,
          year: t.year ?? undefined
        }))
    }))
    const res = await window.api.rekordboxUsb.syncPlaylists(usbRoot, payload)
    setWriting(false)
    setProgress(null)
    if ('error' in res) {
      showToast(`USB sync failed: ${res.error}`, 'error')
      return
    }
    const n = res.playlists.length
    const skippedCount = res.playlists.reduce((s, p) => s + p.skipped.length, 0)
    const parts = [`${res.totalLinked} linked`, `${res.totalAdded} copied`]
    if (skippedCount) parts.push(`${skippedCount} skipped`)
    showToast(`Synced ${n} playlist${n === 1 ? '' : 's'} → USB · ${parts.join(' · ')} · backup saved`, 'success')
    await read(usbRoot)
  }, [usbRoot, selectedPlaylists, libTrackById, showToast, read])

  return (
    <div className="rounded border border-border/40 overflow-hidden">
      {/* Header / detection */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 bg-ink/[0.02] flex-wrap">
        <span className="font-mono text-[12px] text-ink-soft">Rekordbox USB</span>
        {usbs.length > 0 ? (
          <div className="flex items-center gap-1.5">
            {usbs.map((u) => (
              <button
                key={u}
                onClick={() => setUsbRoot(u)}
                className={`font-mono text-[12px] px-2 py-0.5 rounded border transition-colors ${
                  usbRoot === u
                    ? 'border-accent/50 bg-accent/10 text-ink'
                    : 'border-border/40 text-muted hover:text-ink'
                }`}
              >
                {basename(u)}
              </button>
            ))}
          </div>
        ) : (
          <span className="font-mono text-[11px] text-muted/50">no stick detected</span>
        )}
        <div className="flex-1" />
        <button onClick={scan} className="font-mono text-[11px] text-muted hover:text-ink px-1.5 py-0.5">
          rescan
        </button>
        <button
          onClick={browse}
          className="font-mono text-[11px] text-muted hover:text-ink px-2 py-0.5 border border-border/40 rounded"
        >
          browse…
        </button>
        <button
          onClick={openInit}
          className="font-mono text-[11px] text-accent/90 hover:text-accent px-2 py-0.5 border border-accent/40 rounded"
        >
          ＋ new USB
        </button>
        {usbRoot && (
          <button
            onClick={eject}
            title="Safely unmount this USB"
            className="font-mono text-[11px] text-muted hover:text-ink px-2 py-0.5 border border-border/40 rounded"
          >
            ⏏ eject
          </button>
        )}
      </div>

      {/* Initialise a blank USB */}
      {initVolumes && (
        <div className="px-3 py-2.5 border-b border-border/20 bg-accent/[0.03] space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-ink-soft">Start a new USB — pick a blank drive:</span>
            <div className="flex-1" />
            <button onClick={() => setInitVolumes(null)} className="font-mono text-[11px] text-muted hover:text-ink">cancel</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {initVolumes.filter((v) => !v.hasRekordbox).map((v) => (
              <button
                key={v.root}
                onClick={() => initVolume(v.root)}
                disabled={initializing}
                className="font-mono text-[12px] px-2 py-0.5 rounded border border-border/40 text-ink-soft hover:border-accent/50 hover:text-ink transition-colors disabled:opacity-40"
                title={v.root}
              >
                {initializing ? '…' : v.name}
              </button>
            ))}
            <button
              onClick={initBrowse}
              disabled={initializing}
              className="font-mono text-[11px] px-2 py-0.5 rounded border border-border/40 text-muted hover:text-ink disabled:opacity-40"
            >
              browse…
            </button>
          </div>
          {initVolumes.filter((v) => !v.hasRekordbox).length === 0 && (
            <div className="font-mono text-[10px] text-muted/50">
              No blank drives detected — plug one in and reopen, or use browse.
            </div>
          )}
          <div className="font-mono text-[10px] text-muted/40">
            Creates the Rekordbox folder structure + an empty database. Existing Rekordbox sticks are skipped.
          </div>
        </div>
      )}

      {/* Body */}
      {loading && (
        <div className="px-3 py-6 text-center font-mono text-[12px] text-muted">reading export.pdb…</div>
      )}
      {error && <div className="px-3 py-3 font-mono text-[12px] text-red-500">{error}</div>}

      {!loading && !error && !data && (
        <div className="px-3 py-5 font-mono text-[11px] text-muted/60 leading-relaxed">
          Plug in a USB prepared with Rekordbox (Export mode), or <strong>browse…</strong> to its drive. Reads
          the playlists and tracks straight off the stick — no Rekordbox needed.
        </div>
      )}

      {data && !loading && (
        <div className="flex" style={{ minHeight: 220, maxHeight: 360 }}>
          {/* Playlist tree */}
          <div className="w-1/2 border-r border-border/20 overflow-y-auto py-1">
            <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted/50">
              {data.trackCount.toLocaleString()} tracks
            </div>
            <PlaylistTree
              nodes={data.playlists}
              depth={0}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          </div>

          {/* Track list of the selected playlist */}
          <div className="w-1/2 overflow-y-auto">
            {!selected && (
              <div className="px-3 py-4 font-mono text-[11px] text-muted/50">select a playlist</div>
            )}
            {selected && (
              <>
                <div className="px-3 py-1.5 font-mono text-[11px] text-ink-soft border-b border-border/15 sticky top-0 bg-chassis">
                  {selected.name} · {selectedTracks.length}
                </div>
                {selectedTracks.map((t, i) => (
                  <div
                    key={`${t.id}-${i}`}
                    className="flex items-center gap-2 px-3 py-1 border-b border-border/10 font-mono text-[12px]"
                  >
                    <span className="text-muted/40 tabular-nums w-5 text-right shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-ink truncate">{t.title || '—'}</div>
                      <div className="text-muted truncate text-[11px]">{t.artist}</div>
                    </div>
                    <span className="text-muted tabular-nums shrink-0">{formatBpm(t.bpm)}</span>
                    <span className="text-accent/70 shrink-0 w-7 text-right">{t.key || ''}</span>
                    <span className="text-muted/60 tabular-nums shrink-0">
                      {formatDuration(t.durationSeconds)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Send Offcut playlists to this USB */}
      {data && !loading && (
        <div className="border-t border-border/20 px-3 py-2.5 bg-ink/[0.02] space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted/60">
              sync playlists to this usb
            </span>
            <div className="flex-1" />
            {syncablePlaylists.length > 0 && (
              <button
                onClick={() =>
                  setSelectedIds(
                    selectedIds.size === syncablePlaylists.length
                      ? new Set()
                      : new Set(syncablePlaylists.map((p) => p.id))
                  )
                }
                className="font-mono text-[10px] text-muted hover:text-ink"
              >
                {selectedIds.size === syncablePlaylists.length ? 'none' : 'all'}
              </button>
            )}
          </div>

          {/* Playlist checklist */}
          <div className="max-h-40 overflow-y-auto rounded border border-border/30 divide-y divide-border/10">
            {syncablePlaylists.length === 0 && (
              <div className="px-2 py-2 font-mono text-[11px] text-muted/50">No Offcut playlists yet.</div>
            )}
            {syncablePlaylists.map((p) => (
              <label
                key={p.id}
                className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-ink/[0.03]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(p.id)}
                  onChange={() => toggleSelected(p.id)}
                  className="accent-accent shrink-0"
                  disabled={writing}
                />
                <span className="font-mono text-[12px] text-ink-soft truncate flex-1">{p.name}</span>
                <span className="font-mono text-[11px] text-muted/50 tabular-nums">{p.trackIds.length}</span>
              </label>
            ))}
          </div>

          {/* Progress bar (while syncing) */}
          {writing && (
            <div className="space-y-1">
              <div className="h-1 rounded-full bg-ink/10 overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-150"
                  style={{
                    width: progress
                      ? `${Math.round(((progress.playlistIndex + (progress.trackIndex + 1) / Math.max(1, progress.trackTotal)) / Math.max(1, progress.playlistTotal)) * 100)}%`
                      : '4%'
                  }}
                />
              </div>
              <div className="font-mono text-[10px] text-muted/70 truncate">
                {progress
                  ? `playlist ${progress.playlistIndex + 1}/${progress.playlistTotal} · ${progress.action === 'copy' ? 'copying' : 'linking'} ${progress.trackIndex + 1}/${progress.trackTotal} — ${progress.track}`
                  : 'preparing…'}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-[11px] text-muted/70">
              {selectedPlaylists.length > 0 && (
                <>
                  {aggregate.total} tracks · {aggregate.onUsb} on USB · {aggregate.toCopy} to copy
                </>
              )}
            </div>
            <button
              onClick={syncSelected}
              disabled={writing || selectedPlaylists.length === 0}
              className="font-mono text-[12px] px-3 py-1 rounded border border-accent/50 bg-accent/10 text-ink hover:bg-accent/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {writing ? 'syncing…' : `↧ sync ${selectedPlaylists.length || ''} to USB`.trim()}
            </button>
          </div>

          <div className="font-mono text-[10px] text-muted/40 leading-relaxed">
            Tracks already on the stick are linked; the rest are copied in (audio + beatgrid) and added.
            Re-syncing a playlist updates it in place. The original export.pdb is backed up off the USB first.
          </div>
        </div>
      )}
    </div>
  )
}
