/**
 * RekordboxUsbPanel — read a prepared Rekordbox USB directly.
 *
 * Parses the stick's PIONEER/rekordbox/export.pdb (DeviceSQL — what the CDJs
 * read) and shows its playlist tree + tracks. Read-only for now (M0); writing
 * playlists back to USB is a later milestone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { formatDuration, formatBpm } from '../lib/format'
import type { UsbExport, UsbPlaylistNode, UsbTrack, UsbDeviceSettings, UsbWaveformColors } from '@shared/types'

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

// Waveform-colour presets. The first few are built from Offcut's own palette
// (terracotta accent #D86A4A, cream ink #ECE3CC, the deck waveform browns).
const WAVEFORM_COLOR_PRESETS: { name: string; colors: UsbWaveformColors }[] = [
  { name: 'Offcut', colors: { low: '#6b5a3e', mid: '#c2683e', high: '#ece3cc' } },
  { name: 'Terracotta', colors: { low: '#7a3b22', mid: '#d86a4a', high: '#f0d8b0' } },
  { name: 'Ember', colors: { low: '#5e2a12', mid: '#ef7a3c', high: '#e0a83c' } },
  { name: 'Classic', colors: { low: '#1e64ff', mid: '#ff8c1a', high: '#ffffff' } }
]

/** Live preview of the exported RGB waveform: a synthetic 3-band waveform drawn
 *  with the magnitude-weighted blend of the chosen band colours — the same blend
 *  the export encodes into PWV5. */
function WaveformColorPreview({ colors }: { colors: UsbWaveformColors }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const W = cv.width
    const H = cv.height
    const N = 160
    const cl = hexToRgb(colors.low)
    const cm = hexToRgb(colors.mid)
    const ch = hexToRgb(colors.high)
    ctx.clearRect(0, 0, W, H)
    for (let i = 0; i < N; i++) {
      const t = i / N
      const lo = Math.max(0, 0.45 + 0.5 * Math.sin(t * 21) * Math.sin(t * 3.1))
      const md = Math.max(0, 0.4 + 0.45 * Math.sin(t * 8.5 + 1))
      const hi = Math.max(0, 0.28 + 0.34 * Math.abs(Math.sin(t * 47)) * (0.5 + 0.5 * Math.sin(t * 5)))
      const total = lo + md + hi || 1
      const r = (lo * cl[0] + md * cm[0] + hi * ch[0]) / total
      const g = (lo * cl[1] + md * cm[1] + hi * ch[1]) / total
      const b = (lo * cl[2] + md * cm[2] + hi * ch[2]) / total
      const h = Math.max(lo, md, hi) * H * 0.46
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`
      ctx.fillRect((i / N) * W, H / 2 - h, W / N + 0.6, h * 2)
    }
  }, [colors])
  return <canvas ref={ref} width={320} height={48} className="w-full rounded bg-black/60" />
}

const DEVICE_SETTING_FIELDS: {
  key: keyof UsbDeviceSettings
  label: string
  options: { value: string; label: string }[]
}[] = [
  { key: 'waveformColor', label: 'Waveform colour', options: [{ value: 'blue', label: 'Blue' }, { value: 'rgb', label: 'RGB' }, { value: '3band', label: '3Band' }] },
  { key: 'waveformPosition', label: 'Waveform position', options: [{ value: 'center', label: 'Center' }, { value: 'left', label: 'Left' }] },
  { key: 'waveformDivisions', label: 'Waveform divisions', options: [{ value: 'timescale', label: 'Time Scale' }, { value: 'phrase', label: 'Phrase' }] },
  { key: 'overviewWaveform', label: 'Overview waveform', options: [{ value: 'half', label: 'Half' }, { value: 'full', label: 'Full' }] },
  { key: 'keyDisplay', label: 'Key display', options: [{ value: 'classic', label: 'Classic' }, { value: 'alphanumeric', label: 'Alphanumeric' }] },
  { key: 'jogDisplay', label: 'Jog display', options: [{ value: 'auto', label: 'Auto' }, { value: 'info', label: 'Info' }, { value: 'simple', label: 'Simple' }, { value: 'artwork', label: 'Artwork' }] },
  { key: 'timeMode', label: 'Time mode', options: [{ value: 'elapsed', label: 'Elapsed' }, { value: 'remain', label: 'Remain' }] },
  { key: 'autoCue', label: 'Auto cue', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] },
  { key: 'quantize', label: 'Quantize', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
  { key: 'quantizeBeat', label: 'Quantize beat', options: [{ value: '1', label: '1 Beat' }, { value: '1/2', label: '1/2 Beat' }, { value: '1/4', label: '1/4 Beat' }, { value: '1/8', label: '1/8 Beat' }] },
  { key: 'hotcueAutoload', label: 'Hot cue auto-load', options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'rekordbox', label: 'rekordbox' }] }
]

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
  const [syncMode, setSyncMode] = useState<'add' | 'replace'>('add')
  const [progress, setProgress] = useState<{
    playlist: string; playlistIndex: number; playlistTotal: number
    track: string; trackIndex: number; trackTotal: number; action: 'link' | 'copy'
  } | null>(null)

  // Initialise-a-blank-USB state.
  const [initVolumes, setInitVolumes] = useState<{ root: string; name: string; hasRekordbox: boolean }[] | null>(null)
  const [initializing, setInitializing] = useState(false)

  // Device settings + RGB-waveform colours written on export (persisted in app settings).
  const [devSettings, setDevSettings] = useState<UsbDeviceSettings | null>(null)
  const [waveColors, setWaveColors] = useState<UsbWaveformColors | null>(null)
  const [exportCues, setExportCues] = useState(false)
  useEffect(() => {
    window.api.settings.get().then((s) => {
      setDevSettings(s.usbDeviceSettings)
      setWaveColors(s.usbWaveformColors)
      setExportCues(s.usbExportCues ?? false)
    })
  }, [])
  const updateExportCues = useCallback((on: boolean) => {
    setExportCues(on)
    void window.api.settings.save({ usbExportCues: on })
  }, [])
  const updateDevSetting = useCallback((key: keyof UsbDeviceSettings, value: string) => {
    setDevSettings((prev) => {
      if (!prev) return prev
      const next = { ...prev, [key]: value } as UsbDeviceSettings
      void window.api.settings.save({ usbDeviceSettings: next })
      return next
    })
  }, [])
  const updateWaveColor = useCallback((band: keyof UsbWaveformColors, value: string) => {
    setWaveColors((prev) => {
      if (!prev) return prev
      const next = { ...prev, [band]: value }
      void window.api.settings.save({ usbWaveformColors: next })
      return next
    })
  }, [])
  const applyWaveColors = useCallback((c: UsbWaveformColors) => {
    setWaveColors(c)
    void window.api.settings.save({ usbWaveformColors: c })
  }, [])

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
          year: t.year ?? undefined,
          key: t.key ?? undefined,
          album: t.album || undefined,
          genre: t.genre || undefined,
          cuePoints: t.cuePoints
        }))
    }))
    const res = await window.api.rekordboxUsb.syncPlaylists(usbRoot, payload, syncMode)
    setWriting(false)
    setProgress(null)
    if ('error' in res) {
      showToast(`USB sync failed: ${res.error}`, 'error')
      return
    }
    const n = res.playlists.length
    const skippedCount = res.skipped.length
    const parts = [`${res.totalTracks} track${res.totalTracks === 1 ? '' : 's'}`]
    if (skippedCount) parts.push(`${skippedCount} skipped`)
    showToast(`Synced ${n} playlist${n === 1 ? '' : 's'} → USB · ${parts.join(' · ')} · backup saved`, 'success')
    await read(usbRoot)
  }, [usbRoot, selectedPlaylists, libTrackById, showToast, read, syncMode])

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

          {devSettings && (
            <div className="rounded border border-border/30 p-2.5 space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wide text-muted/60">Device settings (written on export)</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                {DEVICE_SETTING_FIELDS.map((f) => (
                  <label key={f.key} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="text-muted/70 whitespace-nowrap">{f.label}</span>
                    <select
                      value={devSettings[f.key]}
                      onChange={(e) => updateDevSetting(f.key, e.target.value)}
                      className="min-w-[7rem] appearance-none rounded border border-border/50 bg-black/40 px-2 py-1 pr-6 text-ink font-medium cursor-pointer hover:border-accent/50 focus:border-accent focus:outline-none bg-[length:10px] bg-[right_0.4rem_center] bg-no-repeat"
                      style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%23c8b89a' stroke-width='1.5'><path d='M1 1l4 4 4-4'/></svg>\")" }}
                    >
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value} className="bg-surface text-ink">{o.label}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {waveColors && (
            <div className="rounded border border-border/30 p-2.5 space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wide text-muted/60">Waveform colours · RGB mode</div>
              <div className="flex flex-wrap gap-1.5">
                {WAVEFORM_COLOR_PRESETS.map((p) => {
                  const active = waveColors.low === p.colors.low && waveColors.mid === p.colors.mid && waveColors.high === p.colors.high
                  return (
                    <button
                      key={p.name}
                      onClick={() => applyWaveColors(p.colors)}
                      className={`flex items-center gap-1.5 rounded border px-1.5 py-1 font-mono text-[10px] transition-colors ${active ? 'border-accent/70 text-ink bg-accent/10' : 'border-border/40 text-muted/70 hover:text-ink hover:border-border'}`}
                    >
                      <span className="h-3 w-6 rounded-sm" style={{ background: `linear-gradient(90deg, ${p.colors.low}, ${p.colors.mid}, ${p.colors.high})` }} />
                      {p.name}
                    </button>
                  )
                })}
              </div>
              <WaveformColorPreview colors={waveColors} />
              <div className="grid grid-cols-3 gap-2">
                {([['low', 'Bass'], ['mid', 'Mid'], ['high', 'Treble']] as const).map(([band, label]) => (
                  <label key={band} className="flex items-center gap-2 font-mono text-[11px] text-muted/70">
                    <input
                      type="color"
                      value={waveColors[band]}
                      onChange={(e) => updateWaveColor(band, e.target.value)}
                      className="h-6 w-8 rounded border border-border/50 bg-transparent cursor-pointer"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <div className="font-mono text-[10px] text-muted/40 leading-relaxed">
                Applied to the exported RGB waveform. Set <span className="text-muted/70">Waveform colour → RGB</span> above for players to show these.
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 font-mono text-[11px] text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={exportCues}
              onChange={(e) => updateExportCues(e.target.checked)}
              className="accent-accent"
            />
            <span>Export hot cues &amp; memory cues <span className="text-muted/50">(beta — verify on your player; turn off if waveforms don&apos;t show)</span></span>
          </label>

          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-[11px] text-muted/70">
              {selectedPlaylists.length > 0 && (
                <>
                  {aggregate.total} tracks · {aggregate.onUsb} on USB · {aggregate.toCopy} to copy
                </>
              )}
            </div>
            <div className="flex rounded border border-border/40 overflow-hidden font-mono text-[10px]" title="Add: keep what's on the stick. Replace: wipe and write only these.">
              {(['add', 'replace'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setSyncMode(m)}
                  className={`px-2 py-1 transition-colors ${syncMode === m ? 'bg-accent/15 text-ink' : 'text-muted/60 hover:text-ink'}`}
                >
                  {m}
                </button>
              ))}
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
