import { useState, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import type { Track, CuePoint } from '@shared/types'

const KEY_OPTIONS = [
  '', '1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A',
  '1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B'
]

const GENRE_SUGGESTIONS = [
  'House','Tech House','Deep House','Techno','Trance','Drum and Bass',
  'Jungle','Garage','Disco','Funk','Soul','Hip-Hop','R&B',
  'Breaks','Electro','Minimal','Progressive','Melodic Techno'
]

interface TrackDetailProps {
  trackId: string | null
  onClose: () => void
}

export function TrackDetail({ trackId, onClose }: TrackDetailProps): JSX.Element | null {
  const tracks = useLibraryStore((s) => s.tracks)
  const updateTrack = useLibraryStore((s) => s.updateTrack)

  const track = tracks.find((t) => t.id === trackId) ?? null
  const [draft, setDraft] = useState<Track | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(track ? { ...track } : null)
    setDirty(false)
    setSaved(false)
  }, [trackId, track?.id])

  if (!draft) return null

  const set = <K extends keyof Track>(key: K, value: Track[K]): void => {
    setDraft((d) => d ? { ...d, [key]: value } : d)
    setDirty(true)
    setSaved(false)
  }

  const handleSave = async (): Promise<void> => {
    if (!draft || !dirty) return
    setSaving(true)
    try {
      await updateTrack({
        id: draft.id,
        title: draft.title,
        artist: draft.artist,
        album: draft.album,
        genre: draft.genre,
        bpm: draft.bpm,
        key: draft.key,
        rating: draft.rating,
        comment: draft.comment,
        tags: draft.tags,
        cuePoints: draft.cuePoints
      })
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const formatDuration = (secs: number | null): string => {
    if (!secs) return '—'
    const m = Math.floor(secs / 60)
    const s = Math.round(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <aside className="w-72 bg-surface-900 border-l border-white/5 flex flex-col overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/40">Track Detail</span>
        <button
          onClick={onClose}
          className="text-white/30 hover:text-white transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            className={INPUT_CLS}
          />
        </Field>

        <Field label="Artist">
          <input
            value={draft.artist}
            onChange={(e) => set('artist', e.target.value)}
            className={INPUT_CLS}
          />
        </Field>

        <Field label="Album">
          <input
            value={draft.album}
            onChange={(e) => set('album', e.target.value)}
            className={INPUT_CLS}
          />
        </Field>

        <Field label="Genre">
          <input
            value={draft.genre}
            list="genre-list"
            onChange={(e) => set('genre', e.target.value)}
            className={INPUT_CLS}
          />
          <datalist id="genre-list">
            {GENRE_SUGGESTIONS.map((g) => <option key={g} value={g} />)}
          </datalist>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="BPM">
            <input
              type="number"
              step="0.1"
              min="0"
              max="300"
              value={draft.bpm ?? ''}
              onChange={(e) => set('bpm', e.target.value ? Number(e.target.value) : null)}
              className={INPUT_CLS + ' tabular-nums'}
            />
          </Field>

          <Field label="Key">
            <select
              value={draft.key ?? ''}
              onChange={(e) => set('key', e.target.value || null)}
              className={INPUT_CLS}
            >
              {KEY_OPTIONS.map((k) => (
                <option key={k} value={k}>{k || '—'}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Rating">
          <StarEditor rating={draft.rating} onChange={(r) => set('rating', r)} />
        </Field>

        <Field label="Comment">
          <textarea
            value={draft.comment}
            rows={2}
            onChange={(e) => set('comment', e.target.value)}
            className={INPUT_CLS + ' resize-none'}
          />
        </Field>

        <Field label="Tags">
          <TagEditor
            tags={draft.tags}
            onChange={(tags) => set('tags', tags)}
          />
        </Field>

        <div className="border-t border-white/5 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/30 mb-3">Cue Points</p>
          <CuePointList
            cuePoints={draft.cuePoints}
            onChange={(cues) => set('cuePoints', cues)}
          />
        </div>

        <div className="border-t border-white/5 pt-4 space-y-1">
          <MetaRow label="Duration" value={formatDuration(draft.durationSeconds)} />
          <MetaRow label="File" value={draft.filePath.split('/').pop() ?? draft.filePath} />
          <MetaRow label="Added" value={draft.dateAdded ? new Date(draft.dateAdded).toLocaleDateString() : '—'} />
          {Object.entries(draft.sourceIds).length > 0 && (
            <MetaRow
              label="Sources"
              value={Object.keys(draft.sourceIds).join(', ')}
            />
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-white/5 shrink-0">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`w-full py-2 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? 'bg-green-600/20 text-green-400 border border-green-600/30'
              : dirty
              ? 'bg-accent hover:bg-accent-hover text-white'
              : 'bg-white/5 text-white/30 cursor-default'
          }`}
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : dirty ? 'Save Changes' : 'No Changes'}
        </button>
      </div>
    </aside>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-white/40 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  )
}

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-accent transition-colors'

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-white/30">{label}</span>
      <span className="text-white/60 truncate ml-2 text-right max-w-[60%]" title={value}>{value}</span>
    </div>
  )
}

function StarEditor({ rating, onChange }: { rating: number; onChange: (r: number) => void }): JSX.Element {
  const [hover, setHover] = useState(0)
  return (
    <div className="flex gap-1">
      {Array.from({ length: 5 }, (_, i) => i + 1).map((star) => (
        <button
          key={star}
          onClick={() => onChange(rating === star ? 0 : star)}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
          className={`text-lg transition-colors ${
            star <= (hover || rating) ? 'text-yellow-400' : 'text-white/15'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): JSX.Element {
  const [input, setInput] = useState('')

  const addTag = (): void => {
    const tag = input.trim()
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag])
    }
    setInput('')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 bg-accent/20 text-accent text-xs px-2 py-0.5 rounded-full"
          >
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="opacity-60 hover:opacity-100">×</button>
          </span>
        ))}
      </div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
        placeholder="Add tag, press Enter…"
        className={INPUT_CLS}
      />
    </div>
  )
}

function CuePointList({ cuePoints, onChange }: { cuePoints: CuePoint[]; onChange: (c: CuePoint[]) => void }): JSX.Element {
  const hotcues = cuePoints.filter((c) => c.type === 'hotcue').sort((a, b) => a.index - b.index)
  const memory = cuePoints.filter((c) => c.type === 'memory').sort((a, b) => a.positionMs - b.positionMs)

  const update = (updated: CuePoint): void => {
    onChange(cuePoints.map((c) => c.index === updated.index && c.type === updated.type ? updated : c))
  }

  if (cuePoints.length === 0) {
    return <p className="text-xs text-white/25 italic">No cue points</p>
  }

  return (
    <div className="space-y-1">
      {[...hotcues, ...memory].map((cue, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: cue.color || '#ff8c00' }}
          />
          <span className="text-white/40 w-8 shrink-0">
            {cue.type === 'hotcue' ? `H${cue.index + 1}` : 'MEM'}
          </span>
          <span className="text-white/60 tabular-nums w-16 shrink-0">
            {formatMs(cue.positionMs)}
          </span>
          <input
            value={cue.label}
            onChange={(e) => update({ ...cue, label: e.target.value })}
            placeholder="Label…"
            className="flex-1 bg-transparent border-b border-white/10 focus:border-accent outline-none text-white/70 py-0.5"
          />
        </div>
      ))}
    </div>
  )
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
