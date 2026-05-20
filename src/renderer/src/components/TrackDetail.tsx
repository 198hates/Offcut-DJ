import { useState, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { CamelotWheel } from './CamelotWheel'
import type { Track, CuePoint } from '@shared/types'

const TRACK_COLORS = [
  '#6E8059', '#4E7090', '#B07A4E', '#C9A02C',
  '#B86E72', '#874850', '#8E8473', '#B84A2B',
]

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
  const showToast = useToastStore((s) => s.show)
  const [writing, setWriting] = useState(false)

  const track = tracks.find((t) => t.id === trackId) ?? null
  const [draft, setDraft] = useState<Track | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<'inspector' | 'edit'>('inspector')

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
        color: draft.color,
        energy: draft.energy,
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

  const handleWriteToFile = async (): Promise<void> => {
    if (!draft) return
    setWriting(true)
    try {
      // If there are unsaved changes, save them to the DB first
      if (dirty) await handleSave()
      const r = await window.api.library.writeTagsToFile(draft.id)
      if (r.skipped)       showToast('Format not supported for tag writing', 'info')
      else if (r.success)  showToast('Tags written to file', 'success')
      else                 showToast(`Write failed: ${r.error ?? 'unknown error'}`, 'error')
    } finally {
      setWriting(false)
    }
  }

  const fmtDur = (secs: number | null): string => {
    if (!secs) return '—'
    const m = Math.floor(secs / 60)
    const s = Math.round(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <aside className="w-[280px] bg-chassis border-l border-border/30 flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-0">
          {(['inspector', 'edit'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] rounded transition-colors ${
                tab === t ? 'text-ink bg-ink/8 font-bold' : 'text-muted hover:text-ink'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink transition-colors text-base leading-none px-1">×</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'inspector' ? (
          <InspectorTab draft={draft} fmtDur={fmtDur} />
        ) : (
          <EditTab draft={draft} set={set} />
        )}
      </div>

      {tab === 'edit' && (
        <div className="px-3 py-2 border-t border-border/30 shrink-0 flex gap-2">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`flex-1 py-1.5 rounded font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
              saved
                ? 'bg-green-600/15 text-green-600 border border-green-600/25'
                : dirty
                ? 'bg-accent text-paper hover:bg-accent/90'
                : 'bg-ink/5 text-muted cursor-default'
            }`}
          >
            {saving ? 'saving…' : saved ? 'saved!' : dirty ? 'save changes' : 'no changes'}
          </button>
          <button
            onClick={handleWriteToFile}
            disabled={writing}
            title="Write title, artist, BPM, key and other fields into the audio file itself"
            className="shrink-0 px-3 py-1.5 rounded font-mono text-[10px] uppercase tracking-[0.12em] border border-border/40 text-muted hover:text-ink hover:border-border/70 transition-colors disabled:opacity-40"
          >
            {writing ? 'writing…' : 'write to file'}
          </button>
        </div>
      )}
    </aside>
  )
}

// ── Inspector tab ─────────────────────────────────────────────────────────────

function InspectorTab({ draft, fmtDur }: { draft: Track; fmtDur: (s: number | null) => string }): JSX.Element {
  return (
    <div className="space-y-0">
      {/* Track header banner */}
      <div className="px-3 py-3 border-b border-border/30 space-y-0.5">
        <p className="font-sans font-semibold text-[13px] text-ink leading-tight truncate">
          {draft.title || 'Unknown Title'}
        </p>
        <p className="font-mono text-[9.5px] text-muted truncate">
          {[draft.artist, draft.album].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>

      {/* Specs grid */}
      <div className="px-3 py-2 grid grid-cols-2 gap-0 border-b border-border/30">
        <Spec label="BPM" value={draft.bpm ? draft.bpm.toFixed(1) : '—'} accent />
        <Spec label="Key" value={draft.key || '—'} accent />
        <Spec label="Time" value={fmtDur(draft.durationSeconds)} />
        <Spec label="Energy" value={draft.energy ? `${draft.energy}/10` : '—'} />
        <Spec label="Plays" value={draft.playCount > 0 ? String(draft.playCount) : '—'} />
        <Spec label="Last played" value={draft.lastPlayedAt ? new Date(draft.lastPlayedAt).toLocaleDateString() : '—'} />
        <Spec label="Genre" value={draft.genre || '—'} />
        <Spec label="Rating" value={draft.rating ? '★'.repeat(draft.rating) + (draft.rating < 5 ? '☆'.repeat(5 - draft.rating) : '') : '—'} />
        {draft.album && <Spec label="Album" value={draft.album} />}
        <Spec label="Added" value={draft.dateAdded ? new Date(draft.dateAdded).toLocaleDateString() : '—'} />
      </div>

      {/* Camelot wheel */}
      <div className="px-3 py-3 border-b border-border/30">
        <div className="flex items-baseline justify-between mb-2">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
            <span className="text-accent mr-1">03</span>harmonic
          </p>
          {draft.key && (
            <p className="font-mono text-[9px] text-muted">4 compatible</p>
          )}
        </div>
        <div className="flex justify-center">
          <CamelotWheel currentKey={draft.key} size={220} />
        </div>
      </div>

      {/* Cue points */}
      {draft.cuePoints.length > 0 && (
        <div className="px-3 py-3">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
            <span className="text-accent mr-1">04</span>hot cues
          </p>
          <div className="space-y-0">
            {[...draft.cuePoints]
              .sort((a, b) => a.positionMs - b.positionMs)
              .map((cue, i) => (
                <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/20 last:border-b-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: cue.color || '#FF4D14' }} />
                  <span className="font-mono text-[9px] text-muted w-7 shrink-0">
                    {cue.type === 'hotcue' ? `H${(cue.index ?? 0) + 1}` : 'MEM'}
                  </span>
                  <span className="font-mono text-[10px] text-ink tabular-nums w-12 shrink-0">{formatMs(cue.positionMs)}</span>
                  {cue.label && (
                    <span className="font-mono text-[9px] text-ink-soft uppercase tracking-wide truncate">{cue.label}</span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* File meta */}
      <div className="px-3 py-2 border-t border-border/20 space-y-1">
        <Spec label="File" value={draft.filePath.split('/').pop() ?? draft.filePath} />
        {Object.keys(draft.sourceIds).length > 0 && (
          <Spec label="Source" value={Object.keys(draft.sourceIds).join(', ')} />
        )}
      </div>
    </div>
  )
}

function Spec({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-border/20">
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted shrink-0">{label}</span>
      <span className={`font-mono text-[10px] font-bold ml-2 text-right truncate ${accent ? 'text-accent' : 'text-ink'}`}>{value}</span>
    </div>
  )
}

// ── Edit tab ──────────────────────────────────────────────────────────────────

function EditTab({ draft, set }: { draft: Track; set: <K extends keyof Track>(key: K, value: Track[K]) => void }): JSX.Element {
  return (
    <div className="p-3 space-y-3">
      <Field label="Colour tag">
        <ColourPicker value={draft.color} onChange={(c) => set('color', c)} />
      </Field>

      <Field label="Title">
        <input value={draft.title} onChange={(e) => set('title', e.target.value)} className={INPUT} />
      </Field>
      <Field label="Artist">
        <input value={draft.artist} onChange={(e) => set('artist', e.target.value)} className={INPUT} />
      </Field>
      <Field label="Album">
        <input value={draft.album} onChange={(e) => set('album', e.target.value)} className={INPUT} />
      </Field>
      <Field label="Genre">
        <input value={draft.genre} list="genre-list" onChange={(e) => set('genre', e.target.value)} className={INPUT} />
        <datalist id="genre-list">{GENRE_SUGGESTIONS.map((g) => <option key={g} value={g} />)}</datalist>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="BPM">
          <input type="number" step="0.1" min="0" max="300"
            value={draft.bpm ?? ''} onChange={(e) => set('bpm', e.target.value ? Number(e.target.value) : null)}
            className={INPUT + ' tabular-nums'} />
        </Field>
        <Field label="Key">
          <select value={draft.key ?? ''} onChange={(e) => set('key', e.target.value || null)} className={INPUT}>
            {KEY_OPTIONS.map((k) => <option key={k} value={k}>{k || '—'}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Energy (1–10)">
        <div className="flex items-center gap-2">
          <div className="flex gap-px flex-1">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                onClick={() => set('energy', draft.energy === n ? null : n)}
                className="flex-1 h-5 rounded-sm transition-all"
                style={{
                  background: draft.energy != null && n <= draft.energy
                    ? `rgba(255,77,20,${0.4 + (n / 10) * 0.6})`
                    : 'rgb(var(--border-rgb) / 0.4)'
                }}
                title={`Energy ${n}`}
              />
            ))}
          </div>
          <span className="font-mono text-[10px] text-muted w-5 text-right">{draft.energy ?? '—'}</span>
        </div>
      </Field>

      <Field label="Rating">
        <StarEditor rating={draft.rating} onChange={(r) => set('rating', r)} />
      </Field>

      <Field label="Comment">
        <textarea value={draft.comment} rows={2} onChange={(e) => set('comment', e.target.value)} className={INPUT + ' resize-none'} />
      </Field>

      <Field label="Tags">
        <TagEditor tags={draft.tags} onChange={(tags) => set('tags', tags)} />
      </Field>

      <div className="border-t border-border/20 pt-3">
        <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted mb-2">Cue Points</p>
        <CuePointList cuePoints={draft.cuePoints} onChange={(cues) => set('cuePoints', cues)} />
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block font-mono text-[9px] uppercase tracking-[0.15em] text-muted">{label}</label>
      {children}
    </div>
  )
}

const INPUT = 'w-full bg-paper border border-border/40 rounded px-2.5 py-1.5 font-mono text-[10.5px] text-ink outline-none focus:border-accent transition-colors'

function StarEditor({ rating, onChange }: { rating: number; onChange: (r: number) => void }): JSX.Element {
  const [hover, setHover] = useState(0)
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button key={star}
          onClick={() => onChange(rating === star ? 0 : star)}
          onMouseEnter={() => setHover(star)} onMouseLeave={() => setHover(0)}
          className={`text-lg transition-colors ${star <= (hover || rating) ? 'text-accent' : 'text-border'}`}
        >★</button>
      ))}
    </div>
  )
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): JSX.Element {
  const [input, setInput] = useState('')
  const add = (): void => {
    const tag = input.trim()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setInput('')
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span key={tag} className="flex items-center gap-1 bg-accent/15 text-accent font-mono text-[9px] px-2 py-0.5 rounded">
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="opacity-60 hover:opacity-100">×</button>
          </span>
        ))}
      </div>
      <input value={input} onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        placeholder="add tag, press Enter…" className={INPUT} />
    </div>
  )
}

function CuePointList({ cuePoints, onChange }: { cuePoints: CuePoint[]; onChange: (c: CuePoint[]) => void }): JSX.Element {
  const hotcues = cuePoints.filter((c) => c.type === 'hotcue').sort((a, b) => a.index - b.index)
  const memory  = cuePoints.filter((c) => c.type === 'memory').sort((a, b) => a.positionMs - b.positionMs)
  const update = (updated: CuePoint): void =>
    onChange(cuePoints.map((c) => c.index === updated.index && c.type === updated.type ? updated : c))

  if (cuePoints.length === 0)
    return <p className="font-mono text-[9px] text-muted italic">no cue points</p>

  return (
    <div className="space-y-1">
      {[...hotcues, ...memory].map((cue, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: cue.color || '#FF4D14' }} />
          <span className="font-mono text-[9px] text-muted w-7 shrink-0">
            {cue.type === 'hotcue' ? `H${cue.index + 1}` : 'MEM'}
          </span>
          <span className="font-mono text-[9px] text-ink-soft tabular-nums w-12 shrink-0">{formatMs(cue.positionMs)}</span>
          <input
            value={cue.label}
            onChange={(e) => update({ ...cue, label: e.target.value })}
            placeholder="label…"
            className="flex-1 bg-transparent border-b border-border/30 focus:border-accent outline-none font-mono text-[10px] text-ink py-0.5"
          />
        </div>
      ))}
    </div>
  )
}

function ColourPicker({ value, onChange }: { value: string; onChange: (c: string) => void }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {/* No colour */}
      <button
        onClick={() => onChange('')}
        title="No colour"
        className="w-5 h-5 rounded-sm border transition-all flex items-center justify-center"
        style={{
          borderColor: !value ? 'rgb(var(--accent-rgb))' : 'rgb(var(--border-rgb) / 0.5)',
          background: 'rgb(var(--border-rgb) / 0.2)',
          boxShadow: !value ? '0 0 0 1px rgb(var(--accent-rgb))' : 'none'
        }}
      >
        <span className="font-mono text-[8px] text-muted leading-none">—</span>
      </button>
      {TRACK_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          title={c}
          className="w-5 h-5 rounded-sm transition-all"
          style={{
            background: c,
            boxShadow: value === c ? `0 0 0 2px rgb(var(--chassis-rgb)), 0 0 0 3px ${c}` : 'none'
          }}
        />
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
