import { useEffect, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'

type SyncState = 'idle' | 'importing' | 'exporting' | 'done'

export function RekordboxSync(): JSX.Element {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [dbPath, setDbPath] = useState('')
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [lastResult, setLastResult] = useState<string | null>(null)
  const { loadLibrary } = useLibraryStore()
  const { show } = useToastStore()

  useEffect(() => {
    window.api.library.rekordboxDbStatus().then((s) => {
      setAvailable(s.available)
      setDbPath(s.path)
    })
  }, [])

  const importFromDb = async (): Promise<void> => {
    setSyncState('importing')
    setLastResult(null)
    try {
      const result = await window.api.library.importFromRekordboxDb(available ? dbPath : undefined)
      if (result.tracksImported > 0) {
        await loadLibrary()
        const msg = `Imported ${result.tracksImported.toLocaleString()} tracks from Rekordbox`
        show(msg, 'success')
        setLastResult(msg)
      } else if (result.errors.length > 0 && result.errors[0] !== 'Cancelled') {
        show(`Import failed: ${result.errors[0]}`, 'error')
        setLastResult(`Error: ${result.errors[0]}`)
      } else {
        setLastResult('Cancelled')
      }
    } catch (err) {
      show(`Import error: ${(err as Error).message}`, 'error')
    } finally {
      setSyncState('idle')
    }
  }

  const exportToDb = async (): Promise<void> => {
    if (!window.confirm(
      'Sync back to Rekordbox master.db?\n\n' +
      'Make sure Rekordbox is CLOSED before continuing. ' +
      'This will update track metadata and cue points in your Rekordbox library.'
    )) return

    setSyncState('exporting')
    setLastResult(null)
    try {
      const result = await window.api.library.exportToRekordboxDb(available ? dbPath : undefined)
      if (result.cancelled) {
        setLastResult('Cancelled')
      } else if (result.tracksExported > 0) {
        const msg = `Synced ${result.tracksExported.toLocaleString()} tracks to Rekordbox`
        show(msg, 'success')
        setLastResult(msg)
      } else if (result.errors.length > 0) {
        show(`Sync failed: ${result.errors[0]}`, 'error')
        setLastResult(`Error: ${result.errors[0]}`)
      }
    } catch (err) {
      show(`Sync error: ${(err as Error).message}`, 'error')
    } finally {
      setSyncState('idle')
    }
  }

  if (available === null) return <></>

  return (
    <div className="mx-2 mb-2 bg-white/[0.03] border border-white/10 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-accent text-sm">◈</span>
        <span className="text-xs font-semibold text-white/70">Rekordbox Direct Sync</span>
        <span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full ${available ? 'bg-green-900/40 text-green-400' : 'bg-white/5 text-white/30'}`}>
          {available ? 'DB found' : 'Not found'}
        </span>
      </div>

      {available && (
        <p className="text-xs text-white/30 truncate font-mono" title={dbPath}>
          {dbPath.split('/').slice(-3).join('/')}
        </p>
      )}

      {lastResult && (
        <p className={`text-xs ${lastResult.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>
          {lastResult}
        </p>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={importFromDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1.5 bg-accent/20 hover:bg-accent/30 border border-accent/30 rounded-lg text-xs text-accent disabled:opacity-40 transition-colors"
        >
          {syncState === 'importing' ? 'Importing…' : '↓ Import'}
        </button>
        <button
          onClick={exportToDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white disabled:opacity-40 transition-colors"
          title="Rekordbox must be closed"
        >
          {syncState === 'exporting' ? 'Syncing…' : '↑ Sync back'}
        </button>
      </div>

      {!available && (
        <p className="text-xs text-white/25 leading-tight">
          Rekordbox not found at default path. Set it in Settings → Rekordbox.
        </p>
      )}
    </div>
  )
}
