import { useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import type { Track } from '@shared/types'

const KEY_OPTIONS = ['','1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A','1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']

interface BulkEditBarProps {
  selectedIds: string[]
  onClearSelection: () => void
}

export function BulkEditBar({ selectedIds, onClearSelection }: BulkEditBarProps): JSX.Element {
  const { bulkUpdateTracks, deleteTracks, playlists, addTracksToPlaylist } = useLibraryStore()
  const { show } = useToastStore()

  const [field, setField] = useState<keyof Track | ''>('')
  const [value, setValue] = useState('')
  const [applying, setApplying] = useState(false)

  const n = selectedIds.length

  const applyEdit = async (): Promise<void> => {
    if (!field || value === '') return
    setApplying(true)
    try {
      const patch: Partial<Track> = {}
      if (field === 'bpm') patch.bpm = Number(value) || null
      else if (field === 'rating') patch.rating = Number(value)
      else if (field === 'key') patch.key = value || null
      else if (field === 'genre') patch.genre = value
      else if (field === 'artist') patch.artist = value
      else if (field === 'album') patch.album = value
      else return

      await bulkUpdateTracks(selectedIds, patch)
      show(`Updated ${n} track${n !== 1 ? 's' : ''}`, 'success')
      setField('')
      setValue('')
    } finally {
      setApplying(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm(`Delete ${n} track${n !== 1 ? 's' : ''} from your library? This cannot be undone.`)) return
    await deleteTracks(selectedIds)
    show(`Removed ${n} track${n !== 1 ? 's' : ''} from library`, 'info')
    onClearSelection()
  }

  const handleAddToPlaylist = async (playlistId: string): Promise<void> => {
    await addTracksToPlaylist(playlistId, selectedIds)
    const pl = playlists.find((p) => p.id === playlistId)
    show(`Added ${n} track${n !== 1 ? 's' : ''} to ${pl?.name ?? 'playlist'}`, 'success')
  }

  const nonFolderPlaylists = playlists.filter((p) => !p.isFolder)

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-accent/10 border-b border-accent/20 shrink-0">
      <span className="text-sm font-medium text-accent">
        {n} selected
      </span>

      <div className="flex items-center gap-2 flex-1">
        <select
          value={field}
          onChange={(e) => { setField(e.target.value as keyof Track); setValue('') }}
          className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white outline-none"
        >
          <option value="">Set field…</option>
          <option value="genre">Genre</option>
          <option value="artist">Artist</option>
          <option value="album">Album</option>
          <option value="key">Key</option>
          <option value="bpm">BPM</option>
          <option value="rating">Rating</option>
        </select>

        {field === 'key' && (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white outline-none"
          >
            {KEY_OPTIONS.map((k) => <option key={k} value={k}>{k || '—'}</option>)}
          </select>
        )}

        {field === 'rating' && (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white outline-none"
          >
            <option value="">—</option>
            {[1,2,3,4,5].map((r) => <option key={r} value={r}>{'★'.repeat(r)}</option>)}
          </select>
        )}

        {field && !['key','rating'].includes(field) && (
          <input
            type={field === 'bpm' ? 'number' : 'text'}
            placeholder={`New ${field}…`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyEdit()}
            className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white outline-none focus:border-accent placeholder-white/30 w-40"
          />
        )}

        {field && (
          <button
            onClick={applyEdit}
            disabled={applying || !value}
            className="px-3 py-1 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs rounded transition-colors"
          >
            {applying ? 'Applying…' : `Apply to ${n}`}
          </button>
        )}
      </div>

      {nonFolderPlaylists.length > 0 && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) handleAddToPlaylist(e.target.value) }}
          className="bg-white/10 border border-white/20 rounded px-2 py-1 text-xs text-white outline-none"
        >
          <option value="">Add to playlist…</option>
          {nonFolderPlaylists.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      <button
        onClick={handleDelete}
        className="text-red-400/70 hover:text-red-400 text-xs transition-colors"
      >
        Remove from library
      </button>

      <button
        onClick={onClearSelection}
        className="text-white/40 hover:text-white text-xs transition-colors"
      >
        Deselect
      </button>
    </div>
  )
}
