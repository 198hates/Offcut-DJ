import { useEffect, useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'

type SyncState = 'idle' | 'importing' | 'exporting'

export function RekordboxSync(): JSX.Element {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [dbPath, setDbPath] = useState('')
  const [syncState, setSyncState] = useState<SyncState>('idle')
  /* Opt-in, off every time the app starts. This is the only switch that lets the
     export change rekordbox's playlists — it inserts the tracks Offcut has that
     rekordbox lacks (the kept copy of a resolved duplicate, above all) and then
     retires rows whose file is gone AND whose replacement is now in place. Both
     halves or neither: the prune on its own is what shortens playlists. */
  const [syncPlaylists, setSyncPlaylists] = useState(false)
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
    const lines = ['Sync back to Rekordbox master.db?', 'Make sure Rekordbox is CLOSED before continuing.']
    if (syncPlaylists) {
      lines.push(
        'Playlists WILL be changed: tracks Offcut has will be added, and entries ' +
        'whose file is gone will be removed once their replacement is in place. ' +
        'A dated copy of master.db is saved first.'
      )
    } else {
      lines.push('Only track metadata and cues will be written. Playlists will not be touched.')
    }
    if (!window.confirm(lines.join('\n\n'))) return
    setSyncState('exporting')
    try {
      const result = await window.api.library.exportToRekordboxDb(
        available ? dbPath : undefined,
        syncPlaylists
      )
      if (result.tracksExported > 0) {
        // Report what happened to playlists too, in both modes: with the switch
        // off the counts are the answer to "why didn't my playlist change?".
        const notes: string[] = []
        if (result.playlistEntriesAdded) notes.push(`+${result.playlistEntriesAdded} playlist entries`)
        else if (result.playlistEntriesFound) notes.push(`${result.playlistEntriesFound} playlist entries pending`)
        if (result.orphansPruned) notes.push(`${result.orphansPruned} dead entries removed`)
        else if (result.orphansFound) notes.push(`${result.orphansFound} dead rows found`)
        if (result.orphansBlocked) notes.push(`${result.orphansBlocked} dead rows held back`)
        // The important one: tracks rekordbox has never heard of, which is why a
        // playlist can still look short after a sync that reported success.
        if (result.playlistEntriesNoRekordboxRow) {
          notes.push(`${result.playlistEntriesNoRekordboxRow} tracks not in rekordbox`)
        } else if (result.playlistEntriesUnplaceable) {
          notes.push(`${result.playlistEntriesUnplaceable} entries unplaceable`)
        }
        // Ratings and comments rekordbox already had are never replaced, so say
        // when that happened — otherwise it reads as a sync that didn't work.
        const kept =
          (result.titlesKept ?? 0) + (result.ratingsKept ?? 0) + (result.commentsKept ?? 0)
        if (kept) notes.push(`${kept} existing rekordbox value${kept !== 1 ? 's' : ''} kept`)
        show(
          `Synced ${result.tracksExported.toLocaleString()} tracks to Rekordbox` +
            (notes.length ? ` — ${notes.join(', ')}` : ''),
          'success'
        )
      } else if (result.errors.length > 0 && !result.cancelled) {
        show(`Sync failed: ${result.errors[0]}`, 'error')
      }
      // A skipped or failed playlist write is not a failed sync, but it must not
      // pass silently either — the user asked for it and did not get it.
      if (result.tracksExported > 0 && result.errors.length > 0) {
        show(result.errors[0], 'error')
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
        <span className="font-mono text-[12px] text-ink-soft">rekordbox direct</span>
        {available && dbPath && (
          <span className="font-mono text-[12px] text-muted truncate ml-auto" title={dbPath}>
            {dbPath.split('/').pop()}
          </span>
        )}
      </div>

      <label
        title="Off by default. Inserts the tracks Offcut has, then removes dead entries whose replacement is in place."
        className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted hover:text-ink cursor-pointer transition-colors"
      >
        <input
          type="checkbox"
          checked={syncPlaylists}
          onChange={(e) => setSyncPlaylists(e.target.checked)}
        />
        sync playlists too
      </label>

      <div className="flex gap-1">
        <button
          onClick={importFromDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1 rounded font-mono text-[12px] uppercase tracking-[0.1em] bg-accent/10 hover:bg-accent/20 border border-accent/25 text-accent disabled:opacity-40 transition-colors"
        >
          {syncState === 'importing' ? 'importing…' : '↓ import'}
        </button>
        <button
          onClick={exportToDb}
          disabled={syncState !== 'idle'}
          className="flex-1 py-1 rounded font-mono text-[12px] uppercase tracking-[0.1em] bg-ink/5 hover:bg-ink/10 border border-border/30 text-ink-soft hover:text-ink disabled:opacity-40 transition-colors"
          title="Rekordbox must be closed"
        >
          {syncState === 'exporting' ? 'syncing…' : '↑ sync back'}
        </button>
      </div>

      {!available && (
        <p className="font-mono text-[12px] text-muted/60 leading-tight px-1">
          Set path in Settings → Rekordbox
        </p>
      )}
    </div>
  )
}
