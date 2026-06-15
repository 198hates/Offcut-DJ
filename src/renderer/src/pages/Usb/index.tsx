import { useCallback, useEffect, useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { RekordboxUsbPanel } from '../../components/RekordboxUsbPanel'
import { useLibraryStore } from '../../store/libraryStore'
import { useToastStore } from '../../store/toastStore'

function ImportBackupCard(): JSX.Element {
  const showToast = useToastStore((s) => s.show)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const [importing, setImporting] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [includeAnalysis, setIncludeAnalysis] = useState(true)
  const [progress, setProgress] = useState<{ phase: 'tracks' | 'playlists'; current: number; total: number } | null>(null)

  useEffect(() => {
    const off = window.api.rekordboxUsb.onImportProgress((p) => setProgress(p))
    return off
  }, [])

  const importBackup = useCallback(async () => {
    const folder = await window.api.rekordboxUsb.browse()
    if (!folder) return
    setImporting(true)
    setProgress(null)
    const res = await window.api.rekordboxUsb.importBackup(folder, includeAnalysis)
    setImporting(false)
    setProgress(null)
    if ('error' in res) {
      showToast(`Import failed: ${res.error}`, 'error')
      return
    }
    const extra = res.errors.length ? ` · ${res.errors.length} skipped` : ''
    showToast(`Imported ${res.tracksImported} tracks · ${res.playlistsImported} playlists${extra}`, 'success')
    setFinalizing(true)
    await loadLibrary()
    setFinalizing(false)
  }, [showToast, loadLibrary, includeAnalysis])

  return (
    <div className="rounded border border-border/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 bg-ink/[0.02]">
        <span className="font-mono text-[12px] text-ink-soft">Import a USB backup</span>
        <div className="flex-1" />
        <button
          onClick={importBackup}
          disabled={importing || finalizing}
          className="font-mono text-[11px] px-3 py-0.5 rounded border border-accent/50 bg-accent/10 text-ink hover:bg-accent/20 transition-colors disabled:opacity-40"
        >
          {finalizing ? 'updating library…' : importing ? 'importing…' : '↓ import backup folder…'}
        </button>
      </div>
      {importing && (
        <div className="px-3 pt-2.5 space-y-1">
          <div className="h-1 rounded-full bg-ink/10 overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-150"
              style={{ width: progress && progress.total ? `${Math.round((progress.current / progress.total) * 100)}%` : '4%' }}
            />
          </div>
          <div className="font-mono text-[10px] text-muted/70">
            {progress
              ? progress.phase === 'tracks'
                ? `importing tracks ${progress.current.toLocaleString()}/${progress.total.toLocaleString()}…`
                : 'rebuilding playlists…'
              : 'reading backup…'}
          </div>
        </div>
      )}
      <div className="px-3 py-3 space-y-2">
        <label className="flex items-center gap-2 font-mono text-[11px] text-ink-soft cursor-pointer">
          <input
            type="checkbox"
            checked={includeAnalysis}
            onChange={(e) => setIncludeAnalysis(e.target.checked)}
            className="accent-accent"
            disabled={importing || finalizing}
          />
          import beat grids &amp; cues
          <span className="text-muted/50">— slower, and very slow if the backup is in a cloud folder (OneDrive/iCloud)</span>
        </label>
        <div className="font-mono text-[11px] text-muted/60 leading-relaxed">
          Point at a folder that contains a Rekordbox stick&apos;s structure (a <strong>PIONEER/rekordbox/export.pdb</strong>),
          e.g. a backup on your Desktop. Its tracks come into your library with their original Rekordbox data —
          BPM, key, genre, rating{includeAnalysis ? ', beat grids and cues' : ''} — and its playlists are recreated.
          Audio is referenced from the backup folder. Re-importing updates in place (no duplicates).
        </div>
      </div>
    </div>
  )
}

export function UsbPage(): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader marker="⏏" title="usb export" subtitle="read & write Rekordbox USBs directly — no Rekordbox needed" />

      <div className="px-5 py-5 max-w-3xl space-y-6">
        <RekordboxUsbPanel />
        <ImportBackupCard />
      </div>
    </div>
  )
}
