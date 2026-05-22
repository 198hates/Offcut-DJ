import { useState, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { CamelotWheel } from './CamelotWheel'
import { BeatgridEditor } from './BeatgridEditor'
import { compatibilityScore } from '../lib/compatibility'
import { generateCuesForFile } from '../lib/analyzer'
import { useDeckAStore } from '../store/playerStore'
import type { Track, CuePoint, BeatgridMarker } from '@shared/types'

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
  const [editingBeatgrid, setEditingBeatgrid] = useState(false)

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
        customTags: draft.customTags,
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

  const handleSaveBeatgrid = async (beatgrid: BeatgridMarker[], newBpm: number): Promise<void> => {
    await updateTrack({ id: draft.id, beatgrid, bpm: newBpm })
    setDraft((d) => d ? { ...d, beatgrid, bpm: newBpm } : d)
    setEditingBeatgrid(false)
    showToast('Beatgrid saved', 'success')
  }

  return (
    <>
    {editingBeatgrid && (
      <BeatgridEditor
        track={draft}
        onSave={handleSaveBeatgrid}
        onClose={() => setEditingBeatgrid(false)}
      />
    )}
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
          <InspectorTab draft={draft} fmtDur={fmtDur} onEditBeatgrid={() => setEditingBeatgrid(true)} />
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
    </>
  )
}

// ── Inspector tab ─────────────────────────────────────────────────────────────

function InspectorTab({ draft, fmtDur, onEditBeatgrid }: { draft: Track; fmtDur: (s: number | null) => string; onEditBeatgrid: () => void }): JSX.Element {
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
        <Spec label="Danceability" value={draft.danceability != null ? `${Math.round(draft.danceability * 100)}%` : '—'} />
        <Spec label="Plays" value={draft.playCount > 0 ? String(draft.playCount) : '—'} />
        <MoodBar mood={draft.mood} />
        <Spec label="Last played" value={draft.lastPlayedAt ? new Date(draft.lastPlayedAt).toLocaleDateString() : '—'} />
        <Spec label="Genre" value={draft.genre || '—'} />
        <Spec label="Rating" value={draft.rating ? '★'.repeat(draft.rating) + (draft.rating < 5 ? '☆'.repeat(5 - draft.rating) : '') : '—'} />
        {draft.album && <Spec label="Album" value={draft.album} />}
        <Spec label="Added" value={draft.dateAdded ? new Date(draft.dateAdded).toLocaleDateString() : '—'} />
      </div>

      {/* Camelot wheel + mixable tracks */}
      <div className="px-3 py-3 border-b border-border/30">
        <div className="flex items-baseline justify-between mb-2">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
            <span className="text-accent mr-1">03</span>harmonic
          </p>
        </div>
        <div className="flex justify-center">
          <CamelotWheel currentKey={draft.key} size={220} />
        </div>
      </div>

      <MixablePanel track={draft} />

      {/* Beatgrid */}
      <div className="px-3 py-3 border-b border-border/30">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
            <span className="text-accent mr-1">06</span>beatgrid
          </p>
          <button
            onClick={onEditBeatgrid}
            className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted hover:text-accent transition-colors border border-border/35 hover:border-accent/40 rounded px-2 py-0.5"
          >
            {draft.beatgrid.length > 0 ? 'edit' : 'create'}
          </button>
        </div>
        {draft.beatgrid.length > 0 ? (
          <p className="font-mono text-[9px] text-muted mt-1.5">
            {draft.beatgrid.length} markers · {draft.bpm?.toFixed(2) ?? '—'} bpm
          </p>
        ) : (
          <p className="font-mono text-[9px] text-muted/50 mt-1.5 italic">no beatgrid</p>
        )}
      </div>

      {/* Cue points */}
      {draft.cuePoints.length > 0 && (
        <div className="px-3 py-3">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
            <span className="text-accent mr-1">07</span>hot cues
          </p>
          <div className="space-y-0">
            {[...draft.cuePoints]
              .sort((a, b) => a.positionMs - b.positionMs)
              .map((cue, i) => (
                <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/20 last:border-b-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: cue.color || '#D86A4A' }} />
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

      {/* Custom fields */}
      {Object.keys(draft.customTags).length > 0 && (
        <div className="px-3 py-3 border-t border-border/20">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
            <span className="text-accent mr-1">08</span>custom fields
          </p>
          <div className="space-y-1">
            {Object.entries(draft.customTags).map(([k, v]) => (
              <Spec key={k} label={k} value={v} />
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

// ── Mood labels ───────────────────────────────────────────────────────────────
const MOOD_LABEL = (v: number): string => {
  if (v <= -0.6) return 'Dark'
  if (v <= -0.2) return 'Melancholic'
  if (v <   0.2) return 'Neutral'
  if (v <   0.6) return 'Uplifting'
  return 'Euphoric'
}

// ── Mood bar — horizontal slider from Dark to Euphoric ────────────────────────
function MoodBar({ mood }: { mood: number | null }): JSX.Element {
  return (
    <div className="py-1.5 border-b border-border/20 col-span-2">
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted">Mood</span>
        {mood != null && (
          <span className="font-mono text-[10px] font-bold text-ink">
            {MOOD_LABEL(mood)}
            <span className="text-muted font-normal ml-1.5">({mood > 0 ? '+' : ''}{mood.toFixed(2)})</span>
          </span>
        )}
        {mood == null && <span className="font-mono text-[10px] text-muted">—</span>}
      </div>
      {/* Gradient track */}
      <div className="relative h-2 rounded-full overflow-hidden"
        style={{ background: 'linear-gradient(to right, #2a1f3d 0%, #4a3860 20%, #6e6553 45%, #c8904a 70%, #f5c842 100%)' }}>
        {mood != null && (
          <div
            className="absolute top-0 bottom-0 w-2 -translate-x-1/2 rounded-full bg-white shadow"
            style={{ left: `${((mood + 1) / 2) * 100}%`, boxShadow: '0 0 4px rgba(255,255,255,0.8)' }}
          />
        )}
      </div>
      {/* Scale labels */}
      <div className="flex justify-between mt-0.5">
        {['Dark', 'Melancholic', 'Neutral', 'Uplifting', 'Euphoric'].map((l) => (
          <span key={l} className="font-mono text-[7px] text-muted/50">{l}</span>
        ))}
      </div>
    </div>
  )
}

// ── Edit tab ──────────────────────────────────────────────────────────────────

function EditTab({ draft, set }: { draft: Track; set: <K extends keyof Track>(key: K, value: Track[K]) => void }): JSX.Element {
  const [generatingCues, setGeneratingCues] = useState(false)
  const [cueError, setCueError] = useState<string | null>(null)
  const showToast = useToastStore((s) => s.show)

  const handleAutoCue = async (): Promise<void> => {
    if (draft.cuePoints.length > 0) {
      if (!window.confirm(`Replace the ${draft.cuePoints.length} existing cue point${draft.cuePoints.length !== 1 ? 's' : ''} with auto-generated cues?`)) return
    }
    setGeneratingCues(true)
    setCueError(null)
    try {
      const cues = await generateCuesForFile(draft.filePath)
      if (cues.length === 0) {
        setCueError('No structural cues detected — track may be too short or have uniform energy')
      } else {
        set('cuePoints', cues)
        showToast(`${cues.length} cue point${cues.length !== 1 ? 's' : ''} generated — save to apply`, 'success')
      }
    } catch (err) {
      setCueError((err as Error).message || 'Analysis failed')
    } finally {
      setGeneratingCues(false)
    }
  }

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
                    ? `rgba(216,106,74,${0.4 + (n / 10) * 0.6})`
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

      <Field label="Custom Fields">
        <CustomTagEditor tags={draft.customTags} onChange={(t) => set('customTags', t)} />
      </Field>

      <div className="border-t border-border/20 pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted">Cue Points</p>
          <button
            onClick={handleAutoCue}
            disabled={generatingCues}
            title="Analyse energy curve and auto-place structural cue points"
            className="flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 hover:bg-accent/20 disabled:opacity-40 text-accent font-mono text-[9px] uppercase tracking-[0.1em] rounded border border-accent/25 transition-colors"
          >
            {generatingCues ? (
              <>
                <span className="inline-block w-2.5 h-2.5 border border-accent/60 border-t-accent rounded-full animate-spin" />
                analysing…
              </>
            ) : (
              draft.cuePoints.length > 0 ? 'regenerate' : 'auto-cue'
            )}
          </button>
        </div>
        {cueError && (
          <p className="font-mono text-[9px] text-red-400">{cueError}</p>
        )}
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

function CustomTagEditor({ tags, onChange }: { tags: Record<string, string>; onChange: (t: Record<string, string>) => void }): JSX.Element {
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const add = (): void => {
    const k = newKey.trim()
    if (!k) return
    onChange({ ...tags, [k]: newVal.trim() })
    setNewKey('')
    setNewVal('')
  }

  const entries = Object.entries(tags)

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5 bg-ink/[0.03] border border-border/25 rounded px-2 py-1">
          <span className="font-mono text-[9px] text-muted shrink-0 min-w-[60px] truncate" title={k}>{k}</span>
          <span className="font-mono text-[8px] text-muted/50 shrink-0">·</span>
          <input
            value={v}
            onChange={(e) => onChange({ ...tags, [k]: e.target.value })}
            className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[10.5px] text-ink focus:text-ink border-b border-transparent focus:border-accent/50 transition-colors py-0.5"
          />
          <button
            onClick={() => { const { [k]: _, ...rest } = tags; onChange(rest) }}
            className="shrink-0 text-muted/50 hover:text-red-500 transition-colors font-mono text-xs leading-none ml-1"
          >×</button>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="field…"
          className={INPUT + ' flex-1 min-w-0'}
        />
        <input
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="value…"
          className={INPUT + ' flex-1 min-w-0'}
        />
        <button
          onClick={add}
          disabled={!newKey.trim()}
          className="shrink-0 px-2 py-1 bg-accent/10 hover:bg-accent/20 text-accent rounded font-mono text-[10px] transition-colors disabled:opacity-40"
        >+</button>
      </div>
      {entries.length === 0 && (
        <p className="font-mono text-[9px] text-muted/50 italic">no custom fields — add one above</p>
      )}
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
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: cue.color || '#D86A4A' }} />
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

function MixablePanel({ track }: { track: Track }): JSX.Element | null {
  const allTracks = useLibraryStore((s) => s.tracks)
  const loadTrackA = useDeckAStore((s) => s.loadTrack)

  if (!track.bpm && !track.key) return null

  const candidates = allTracks
    .filter((t) => t.id !== track.id)
    .map((t) => ({ track: t, score: compatibilityScore(track, t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)

  if (!candidates.length) return null

  return (
    <div className="px-3 py-3 border-b border-border/30">
      <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
        <span className="text-accent mr-1">04</span>mixable tracks
      </p>
      <div className="space-y-1">
        {candidates.map(({ track: t, score }) => (
          <div
            key={t.id}
            className="flex items-center gap-2 py-1 px-2 rounded hover:bg-ink/[0.05] group transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="font-mono text-[10px] text-ink truncate">{t.title || '—'}</p>
              <p className="font-mono text-[9px] text-muted truncate">{t.artist}</p>
            </div>
            <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">{t.key ?? '—'}</span>
            <span className="font-mono text-[9px] text-muted tabular-nums shrink-0">{t.bpm?.toFixed(0) ?? '—'}</span>
            <div
              className="w-8 h-1 rounded-full shrink-0"
              title={`compatibility: ${Math.round(score * 100)}%`}
              style={{ background: `rgba(var(--accent-rgb), ${0.2 + score * 0.8})` }}
            />
            <button
              onClick={() => loadTrackA(t)}
              className="opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[8px] uppercase tracking-[0.1em] text-accent shrink-0"
              title="Load to deck A"
            >
              A
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
