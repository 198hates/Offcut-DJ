import { useEffect, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'

type SyncState = 'idle' | 'importing' | 'exporting'

export function RekordboxSync(): JSX.Element {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [dbPath, setDbPath] = useState('')
  const [syncState, setSyncState] = useState<SyncState>('idle')
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
    try {
      const result = await window.api.library.importFromRekordboxDb(available ? dbPath : undefined)
      if (result.tracksImported > 0) {
        await loadLibrary()
        show(`Imported ${result.tracksImported.toLocaleString()} tracks from Rekordbox`, 'success')
      } else if (result.errors.length > 0 && result.errors[0] !== 'Cancelled') {
        show(`Import failed: ${result.errors[0]}`, 'error')
      }
    } catch (err) {
      show(`Import error: ${(err as Error).message}`, 'error')
    } finally {
      setSyncState('idle')
    }
  }

  const exportToDb = async (): Promise<void> => {
    if (!window.confirm(
      'Sync back to Rekordbox master.db?\n\nMake sure Rekordbox is CLOSED before continuing.'
    )) return
    setSyncState('exporting')
    try {
      const result = await window.api.library.exportToRekordboxDb(available ? dbPath : undefined)
      if (result.tracksExported > 0) {
        show(`Synced ${result.tracksExported.toLocaleString()} tracks to Rekordbox`, 'success')
      } else if (result.errors.length > 0 && !result.cancelled) {
        show(`Sync failed: ${result.errors[0]}`, 'error')
      }
    } catch (err) {
      show(`Sync error: ${(err as Error).message}`, 'error')
    } finally {
      setSyncState('idle')
    }
  }

  if (available === null) return <></>

  return (
    <div className="mx-2 mb-2 border-t border-border/20 pt-2 space-y-1">
      <div className="flex items-center gap-2 px-1">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: available ? '#6FAE3E' : '#8A8474' }}
        />
        <span className="font-mono text-[9.5px] text-ink-soft">rekordbox direct</span>
        {available && dbPath && (
          <span className="font-mono text-[9px] text-muted truncate ml-auto" title={dbPath}>
            {dbPath.split('/').pop()}
          </span>
        )}
      </div>

      <div className="flex gap-1">
        <button
          onClick={importFromDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1 rounded font-mono text-[9px] uppercase tracking-[0.1em] bg-accent/10 hover:bg-accent/20 border border-accent/25 text-accent disabled:opacity-40 transition-colors"
        >
          {syncState === 'importing' ? 'importing…' : '↓ import'}
        </button>
        <button
          onClick={exportToDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1 rounded font-mono text-[9px] uppercase tracking-[0.1em] bg-ink/5 hover:bg-ink/10 border border-border/30 text-ink-soft hover:text-ink disabled:opacity-40 transition-colors"
          title="Rekordbox must be closed"
        >
          {syncState === 'exporting' ? 'syncing…' : '↑ sync back'}
        </button>
      </div>

      {!available && (
        <p className="font-mono text-[9px] text-muted/60 leading-tight px-1">
          Set path in Settings → Rekordbox
        </p>
      )}
    </div>
  )
}
