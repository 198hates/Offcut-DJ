import { useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import type { Track } from '@shared/types'

const KEY_OPTIONS = ['','1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A','1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']

const COLOR_OPTIONS = [
  { label: 'none', value: '' },
  { label: 'red', value: '#B86E72' },
  { label: 'orange', value: '#C9803A' },
  { label: 'yellow', value: '#C9A02C' },
  { label: 'green', value: '#6E8059' },
  { label: 'teal', value: '#3CA8A1' },
  { label: 'blue', value: '#4E7090' },
  { label: 'indigo', value: '#6060A0' },
  { label: 'purple', value: '#8A5B9A' },
  { label: 'pink', value: '#B84A76' },
]

interface BulkEditBarProps {
  selectedIds: string[]
  onClearSelection: () => void
}

const SEL = 'bg-ink/5 border border-border/40 rounded px-2 py-1 font-mono text-[13px] text-ink outline-none focus:border-accent cursor-pointer'
const INP = 'bg-paper border border-border/40 rounded px-2 py-1 font-mono text-[13px] text-ink outline-none focus:border-accent placeholder-muted'

export function BulkEditBar({ selectedIds, onClearSelection }: BulkEditBarProps): JSX.Element {
  const { bulkUpdateTracks, deleteTracks, playlists, addTracksToPlaylist, tracks, updateTrack } = useLibraryStore()
  const { show } = useToastStore()
  const [field, setField] = useState<keyof Track | '' | 'add-tag'>('')
  const [value, setValue] = useState('')
  const [applying, setApplying] = useState(false)
  const n = selectedIds.length

  const applyEdit = async (): Promise<void> => {
    if (!field || (field !== 'color' && value === '')) return
    setApplying(true)
    try {
      if (field === 'add-tag') {
        // Add tag to each track individually (need existing tags)
        const tag = value.trim().toLowerCase().replace(/\s+/g, '-')
        if (!tag) return
        let count = 0
        for (const id of selectedIds) {
          const track = tracks.find((t) => t.id === id)
          if (!track) continue
          if (track.tags.includes(tag)) continue   // already has this tag
          await updateTrack({ id, tags: [...track.tags, tag] })
          count++
        }
        show(`tagged ${count} track${count !== 1 ? 's' : ''} with "${tag}"`, 'success')
        setField(''); setValue('')
        return
      }
      const patch: Partial<Track> = {}
      if (field === 'bpm') patch.bpm = Number(value) || null
      else if (field === 'rating') patch.rating = Number(value)
      else if (field === 'energy') patch.energy = Number(value)
      else if (field === 'mood') patch.mood = Number(value)
      else if (field === 'color') patch.color = value
      else if (field === 'key') patch.key = value || null
      else if (field === 'genre') patch.genre = value
      else if (field === 'artist') patch.artist = value
      else if (field === 'album') patch.album = value
      else if (field === 'label') patch.label = value
      else if (field === 'year') patch.year = Number(value) || null
      else return
      await bulkUpdateTracks(selectedIds, patch)
      show(`updated ${n} track${n !== 1 ? 's' : ''}`, 'success')
      setField(''); setValue('')
    } finally { setApplying(false) }
  }

  const handleDelete = async (): Promise<void> => {
    if (!window.confirm(`Remove ${n} track${n !== 1 ? 's' : ''} from your library?`)) return
    await deleteTracks(selectedIds)
    show(`removed ${n} track${n !== 1 ? 's' : ''} from library`, 'info')
    onClearSelection()
  }

  const handleAddToPlaylist = async (playlistId: string): Promise<void> => {
    await addTracksToPlaylist(playlistId, selectedIds)
    const pl = playlists.find((p) => p.id === playlistId)
    show(`added ${n} track${n !== 1 ? 's' : ''} to ${pl?.name ?? 'playlist'}`, 'success')
  }

  const nonFolderPlaylists = playlists.filter((p) => !p.isFolder)

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-accent/[0.06] border-b border-accent/20 shrink-0">
      <span className="font-mono text-[13px] font-bold text-accent shrink-0 uppercase tracking-[0.1em]">
        {n} selected
      </span>

      <div className="w-px h-4 bg-border/40 mx-1 shrink-0" />

      <div className="flex items-center gap-1.5 flex-1">
        <select value={field} onChange={(e) => { setField(e.target.value as keyof Track); setValue('') }} className={SEL}>
          <option value="">set field…</option>
          <option value="genre">genre</option>
          <option value="artist">artist</option>
          <option value="album">album</option>
          <option value="label">label</option>
          <option value="year">year</option>
          <option value="key">key</option>
          <option value="bpm">bpm</option>
          <option value="rating">rating</option>
          <option value="energy">energy (1–10)</option>
          <option value="mood">mood (−1 dark → +1 bright)</option>
          <option value="color">colour tag</option>
          <option value="add-tag">add tag</option>
        </select>

        {field === 'key' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} className={SEL}>
            {KEY_OPTIONS.map((k) => <option key={k} value={k}>{k || '—'}</option>)}
          </select>
        )}
        {field === 'rating' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} className={SEL}>
            <option value="">—</option>
            {[1,2,3,4,5].map((r) => <option key={r} value={r}>{'★'.repeat(r)}</option>)}
          </select>
        )}
        {field === 'energy' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} className={SEL}>
            <option value="">—</option>
            {[1,2,3,4,5,6,7,8,9,10].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        )}
        {field === 'mood' && (
          <select value={value} onChange={(e) => setValue(e.target.value)} className={SEL}>
            <option value="">—</option>
            <option value="-1.0">−1.0 · very dark</option>
            <option value="-0.8">−0.8 · dark</option>
            <option value="-0.6">−0.6 · dark</option>
            <option value="-0.4">−0.4 · melancholic</option>
            <option value="-0.2">−0.2 · melancholic</option>
            <option value="0.0">0.0 · neutral</option>
            <option value="0.2">+0.2 · uplifting</option>
            <option value="0.4">+0.4 · uplifting</option>
            <option value="0.6">+0.6 · euphoric</option>
            <option value="0.8">+0.8 · euphoric</option>
            <option value="1.0">+1.0 · very euphoric</option>
          </select>
        )}
        {field === 'color' && (
          <div className="flex items-center gap-1">
            {COLOR_OPTIONS.map((c) => (
              <button key={c.value}
                onClick={() => setValue(c.value)}
                title={c.label}
                className={`w-5 h-5 rounded border transition-all ${value === c.value ? 'border-ink/50 scale-110' : 'border-border/30 opacity-70 hover:opacity-100'}`}
                style={{ background: c.value || 'transparent' }}
              />
            ))}
          </div>
        )}
        {field === 'add-tag' && (
          <input
            type="text"
            placeholder="tag name… (spaces → hyphens)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyEdit()}
            className={`${INP} w-44`}
          />
        )}
        {field && !['key','rating','energy','mood','color','add-tag'].includes(field) && (
          <input
            type={field === 'bpm' ? 'number' : 'text'}
            placeholder={`new ${field}…`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyEdit()}
            className={`${INP} w-32`}
          />
        )}
        {field && (
          <button
            onClick={applyEdit}
            disabled={applying || (field !== 'color' && !value)}
            className="px-2.5 py-1 bg-accent hover:bg-accent/90 disabled:opacity-40 text-paper font-mono text-[13px] uppercase tracking-[0.1em] rounded transition-colors"
          >
            {applying ? 'applying…' : `apply to ${n}`}
          </button>
        )}
      </div>

      {nonFolderPlaylists.length > 0 && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) handleAddToPlaylist(e.target.value) }}
          className={SEL}
        >
          <option value="">add to playlist…</option>
          {nonFolderPlaylists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}

      <div className="w-px h-4 bg-border/40 mx-1 shrink-0" />

      <button onClick={handleDelete} className="font-mono text-[13px] text-red-500/70 hover:text-red-500 transition-colors uppercase tracking-[0.1em]">
        remove
      </button>
      <button onClick={onClearSelection} className="font-mono text-[13px] text-muted hover:text-ink transition-colors uppercase tracking-[0.1em]">
        deselect
      </button>
    </div>
  )
}
