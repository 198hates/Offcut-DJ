import { useState, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import { CamelotWheel } from './CamelotWheel'
import { BeatgridEditor } from './BeatgridEditor'
import { compatibilityScore, harmonicScore } from '../lib/compatibility'
import { findSimilar } from '../lib/similarity'
import { generateCuesForFile, analyzeAudio, downbeatsForTrack } from '../lib/analyzer'
import { resolveCueTemplate } from '../lib/cueTemplates'
import { generateBeatgrid } from '../lib/compatibility'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import type { Track, CuePoint, BeatgridMarker, CutHistory, EditLineage } from '@shared/types'
import { useArtwork } from '../hooks/useArtwork'

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
  const [analysing, setAnalysing] = useState(false)

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

  const handleReanalyse = async (): Promise<void> => {
    if (!draft) return
    setAnalysing(true)
    try {
      const ab = await window.api.audio.readFile(draft.filePath)
      const ctx = new AudioContext()
      const buf = await ctx.decodeAudioData(ab)
      const r = await analyzeAudio(buf)
      await ctx.close()
      const newBpm = r.bpm ?? draft.bpm
      const newGrid = (newBpm && r.offsetMs != null)
        ? generateBeatgrid(newBpm, r.offsetMs, buf.duration * 1000) : draft.beatgrid
      const patch: Partial<Track> & { id: string } = {
        id: draft.id,
        bpm: newBpm, key: r.key ?? draft.key,
        energy: r.energy ?? draft.energy,
        danceability: r.danceability ?? draft.danceability,
        mood: r.mood ?? draft.mood,
        beatgrid: newGrid,
      }
      await updateTrack(patch)
      setDraft((d) => d ? { ...d, ...patch } : d)
      showToast(`Re-analysed: ${newBpm?.toFixed(1)} bpm · ${r.key ?? '—'}`, 'success')
    } catch (e) {
      showToast(`Analysis failed: ${(e as Error).message}`, 'error')
    } finally {
      setAnalysing(false)
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
              className={`px-2.5 py-1 font-mono text-[12px] uppercase tracking-[0.18em] rounded transition-colors ${
                tab === t ? 'text-ink bg-ink/8 font-bold' : 'text-muted hover:text-ink'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {/* Copy info */}
          <button
            title="Copy track info to clipboard"
            onClick={async () => {
              const info = [
                `${draft.title} — ${draft.artist}`,
                [draft.bpm ? `${draft.bpm.toFixed(1)} bpm` : null, draft.key, draft.energy != null ? `nrg ${draft.energy}` : null].filter(Boolean).join(' · '),
                draft.genre || null,
              ].filter(Boolean).join('\n')
              await navigator.clipboard.writeText(info)
              showToast('Copied to clipboard', 'success')
            }}
            className="w-6 h-6 flex items-center justify-center rounded font-mono text-[13px] text-muted/70 hover:text-ink hover:bg-ink/[0.07] transition-colors"
          >
            ⎘
          </button>
          <button onClick={onClose} title="Close inspector" className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-ink hover:bg-ink/[0.07] transition-colors text-lg leading-none">×</button>
        </div>
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
            className={`flex-1 py-1.5 rounded font-mono text-[13px] uppercase tracking-[0.12em] transition-colors ${
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
            onClick={handleReanalyse}
            disabled={analysing}
            title="Re-run audio analysis: BPM, key, energy, danceability, mood"
            className="shrink-0 px-3 py-1.5 rounded font-mono text-[13px] uppercase tracking-[0.12em] border border-border/40 text-muted hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-40"
          >
            {analysing ? 'analysing…' : draft.bpm ? 're-analyse' : 'analyse'}
          </button>
          <button
            onClick={handleWriteToFile}
            disabled={writing}
            title="Write title, artist, BPM, key and other fields into the audio file itself"
            className="shrink-0 px-3 py-1.5 rounded font-mono text-[13px] uppercase tracking-[0.12em] border border-border/40 text-muted hover:text-ink hover:border-border/70 transition-colors disabled:opacity-40"
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
  const artworkUrl = useArtwork(draft.filePath)

  return (
    <div className="space-y-0">
      {/* Track header banner — artwork + title/artist */}
      <div className="border-b border-border/30">
        {artworkUrl ? (
          <div className="relative">
            {/* Full-width artwork image */}
            <img
              src={artworkUrl}
              alt="Album art"
              className="w-full object-cover"
              style={{ maxHeight: 200, display: 'block' }}
            />
            {/* Title overlay on artwork */}
            <div
              className="absolute bottom-0 left-0 right-0 px-3 py-2 space-y-0.5"
              style={{ background: 'linear-gradient(to top, rgba(13,11,8,0.92) 0%, rgba(13,11,8,0.60) 70%, transparent 100%)' }}
            >
              <p className="font-sans font-semibold text-[13px] text-white leading-tight truncate drop-shadow">
                {draft.title || 'Unknown Title'}
              </p>
              <p className="font-mono text-[12px] text-white/70 truncate drop-shadow">
                {[draft.artist, draft.album].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
          </div>
        ) : (
          <div className="px-3 py-3 space-y-0.5">
            <p className="font-sans font-semibold text-[13px] text-ink leading-tight truncate">
              {draft.title || 'Unknown Title'}
            </p>
            <p className="font-mono text-[12px] text-muted truncate">
              {[draft.artist, draft.album].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
        )}
      </div>

      {/* Specs grid — stacked label-over-value cells with a real gutter */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-6 border-b border-border/30">
        <Spec label="BPM" value={draft.bpm ? draft.bpm.toFixed(1) : '—'} accent />
        <Spec label="Key" value={draft.key || '—'} accent />
        <Spec label="Time" value={fmtDur(draft.durationSeconds)} />
        <Spec label="Energy" value={draft.energy ? `${draft.energy}/10` : '—'} />
        <Spec label="Danceability" value={draft.danceability != null ? `${Math.round(draft.danceability * 100)}%` : '—'} />
        <Spec label="Plays" value={draft.playCount > 0 ? String(draft.playCount) : '—'} />
        <MoodBar mood={draft.mood} />
        <Spec label="Last played" value={draft.lastPlayedAt ? new Date(draft.lastPlayedAt).toLocaleDateString() : '—'} />
        <Spec label="Genre" value={draft.genre || '—'} />
        {draft.label && <Spec label="Label" value={draft.label} />}
        {draft.year  && <Spec label="Year"  value={String(draft.year)} />}
        <Spec label="Rating" value={draft.rating ? '★'.repeat(draft.rating) + (draft.rating < 5 ? '☆'.repeat(5 - draft.rating) : '') : '—'} />
        {draft.album && <Spec label="Album" value={draft.album} />}
        <Spec label="Added" value={draft.dateAdded ? new Date(draft.dateAdded).toLocaleDateString() : '—'} />
      </div>

      {/* Camelot wheel + mixable tracks */}
      <div className="px-3 py-3 border-b border-border/30">
        <div className="flex items-baseline justify-between mb-2">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted">
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
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted">
            <span className="text-accent mr-1">06</span>beatgrid
          </p>
          <button
            onClick={onEditBeatgrid}
            className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-accent transition-colors border border-border/35 hover:border-accent/40 rounded px-2 py-0.5"
          >
            {draft.beatgrid.length > 0 ? 'edit' : 'create'}
          </button>
        </div>
        {draft.beatgrid.length > 0 ? (
          <div className="mt-1.5 space-y-1">
            {/* v2 confidence data */}
            {draft.analysedBeatgrid ? (() => {
              const bg = draft.analysedBeatgrid!
              const meanConf = bg.beats.length > 0
                ? bg.beats.reduce((s, b) => s + b.confidence, 0) / bg.beats.length
                : 0
              const confPct = Math.round(meanConf * 100)

              // Trust verdict
              let verdict = 'steady'
              let verdictColor = 'text-green-600 dark:text-green-400'
              if (meanConf < 0.45) {
                verdict = 'low confidence — check manually'
                verdictColor = 'text-red-500'
              } else if (!bg.isConstantTempo) {
                // Find first low-confidence stretch
                const WIN = 8, THRESH = 0.55
                let driftMs: number | null = null
                for (let i = 0; i + WIN <= bg.beats.length; i++) {
                  const wm = bg.beats.slice(i, i + WIN).reduce((s, b) => s + b.confidence, 0) / WIN
                  if (wm < THRESH) { driftMs = bg.beats[i].positionMs; break }
                }
                if (driftMs !== null) {
                  const m = Math.floor(driftMs / 60000), s = Math.floor((driftMs % 60000) / 1000)
                  verdict = `drifts after ${m}:${String(s).padStart(2,'0')}`
                  verdictColor = 'text-amber-500'
                } else {
                  verdict = 'variable tempo'
                  verdictColor = 'text-amber-500'
                }
              }

              const SOURCE_LABELS: Record<string, string> = {
                'beat-this': 'beat this!', essentia: 'essentia js', manual: 'manual', tags: 'tags', mock: 'mock'
              }

              const isKept = bg.source === 'manual'

              return (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent/80 bg-accent/8 px-1.5 py-0.5 rounded">
                      {SOURCE_LABELS[bg.source] ?? bg.source}
                    </span>
                    {isKept && (
                      <span
                        className="font-mono text-[11px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded border"
                        style={{ color: '#C9A02C', borderColor: 'rgba(201,160,44,0.45)', background: 'rgba(201,160,44,0.08)' }}
                        title="Human-verified beatgrid — confidence is definitive"
                      >
                        kept
                      </span>
                    )}
                    <span className="font-mono text-[12px] text-muted">
                      {bg.beats.length} beats · {bg.medianBpm.toFixed(2)} bpm
                    </span>
                  </div>
                  {/* Confidence bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-border/30 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{
                          width: `${confPct}%`,
                          background: meanConf > 0.75 ? '#4A9B6F' : meanConf > 0.5 ? '#C9A02C' : '#B86E72'
                        }}
                      />
                    </div>
                    <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">{confPct}%</span>
                  </div>
                  {/* Trust verdict */}
                  <p className={`font-mono text-[11px] ${verdictColor}`}>{verdict}</p>
                </div>
              )
            })() : (
              <p className="font-mono text-[12px] text-muted">
                {draft.beatgrid.length} markers · {draft.bpm?.toFixed(2) ?? '—'} bpm
              </p>
            )}
          </div>
        ) : (
          <p className="font-mono text-[12px] text-muted/50 mt-1.5 italic">no beatgrid</p>
        )}
      </div>

      {/* Cue points */}
      {draft.cuePoints.length > 0 && (
        <div className="px-3 py-3">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
            <span className="text-accent mr-1">07</span>hot cues
          </p>
          <div className="space-y-0">
            {[...draft.cuePoints]
              .sort((a, b) => a.positionMs - b.positionMs)
              .map((cue, i) => (
                <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/20 last:border-b-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: cue.color || '#D86A4A' }} />
                  <span className="font-mono text-[12px] text-muted w-7 shrink-0">
                    {cue.type === 'hotcue' ? `H${(cue.index ?? 0) + 1}` : 'MEM'}
                  </span>
                  <span className="font-mono text-[13px] text-ink tabular-nums w-12 shrink-0">{formatMs(cue.positionMs)}</span>
                  {cue.label && (
                    <span className="font-mono text-[12px] text-ink-soft uppercase tracking-wide truncate">{cue.label}</span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Provenance */}
      <ProvenanceSection trackId={draft.id} track={draft} />

      {/* Custom fields */}
      {Object.keys(draft.customTags).length > 0 && (
        <div className="px-3 py-3 border-t border-border/20">
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted mb-2">
            <span className="text-accent mr-1">09</span>custom fields
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

// ── Provenance section ────────────────────────────────────────────────────────

function relativeDate(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function freshnessColor(lastPlayedAt: string | null, playCount: number): string | null {
  if (!lastPlayedAt || playCount === 0) return null
  const days = (Date.now() - new Date(lastPlayedAt).getTime()) / 86400000
  if (days > 180) return '#C9A02C'   // amber — rediscovery candidate
  if (days < 7)   return '#4A9B6F'   // green — played this week
  return null
}

function ProvenanceSection({ trackId, track }: { trackId: string; track: Track }): JSX.Element {
  const { tracks } = useLibraryStore()
  const [history, setHistory] = useState<CutHistory | null>(null)
  const [showEditForm, setShowEditForm] = useState(false)
  const [editSearch, setEditSearch] = useState('')
  const [trackOrders, setTrackOrders] = useState<{ id: string; catalogNum: number; title: string }[]>([])

  useEffect(() => {
    window.api.library.getCutHistory(trackId).then((h) => setHistory(h ?? null))
    // Find running orders that include this track
    window.api.library.getRunningOrders().then((orders) => {
      setTrackOrders(
        orders
          .filter((o) => o.entries.some((e) => e.trackId === trackId))
          .map((o) => ({ id: o.id, catalogNum: o.catalogNum, title: o.title }))
      )
    })
  }, [trackId])

  const freshColor = freshnessColor(track.lastPlayedAt, track.playCount)
  const lineage = track.editLineage

  // Resolve track ID → title for mixedFrom display
  const resolveTitle = (id: string | null): string | null => {
    if (!id) return null
    const t = tracks.find((x) => x.id === id)
    return t ? (t.title || t.filePath.split('/').pop() || id) : null
  }

  const handleMarkAsEdit = async (originalTrack: Track) => {
    const newLineage: EditLineage = {
      isEdit: true,
      originalId: originalTrack.id,
      versionLabel: null,
    }
    await window.api.library.updateEditLineage(trackId, newLineage)
    // Patch local store
    const { updateTrack } = useLibraryStore.getState()
    await updateTrack({ id: trackId, editLineage: newLineage })
    setShowEditForm(false)
  }

  const handleClearEdit = async () => {
    const cleared: EditLineage = { isEdit: false, originalId: null, versionLabel: null }
    await window.api.library.updateEditLineage(trackId, cleared)
    const { updateTrack } = useLibraryStore.getState()
    await updateTrack({ id: trackId, editLineage: cleared })
  }

  const searchResults = editSearch.length > 1
    ? tracks
        .filter((t) => t.id !== trackId && (
          t.title.toLowerCase().includes(editSearch.toLowerCase()) ||
          t.artist.toLowerCase().includes(editSearch.toLowerCase())
        ))
        .slice(0, 5)
    : []

  const originalTrack = lineage?.isEdit && lineage.originalId
    ? tracks.find((t) => t.id === lineage.originalId)
    : null

  return (
    <div className="px-3 py-3 border-t border-border/20">
      <div className="flex items-center justify-between mb-2">
        <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted">
          <span className="text-accent mr-1">08</span>provenance
        </p>
        {freshColor && (
          <span
            className="font-mono text-[11px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
            style={{ color: freshColor, background: freshColor + '18' }}
          >
            {freshColor === '#C9A02C' ? 'rediscovery' : 'recent'}
          </span>
        )}
      </div>

      {/* Play history */}
      <div className="space-y-1 mb-2">
        {track.playCount === 0 ? (
          <p className="font-mono text-[12px] text-muted/50 italic">never played</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[13px] font-bold text-ink tabular-nums">{track.playCount}</span>
              <span className="font-mono text-[12px] text-muted">
                play{track.playCount !== 1 ? 's' : ''}
                {track.lastPlayedAt ? ` · last ${relativeDate(track.lastPlayedAt)}` : ''}
              </span>
            </div>
            {/* Last 3 events with mixedFrom */}
            {history && history.plays.slice(0, 3).map((ev) => {
              const from = resolveTitle(ev.mixedFrom)
              return (
                <div key={ev.id} className="flex items-baseline gap-2 pl-1 border-l-2 border-border/30">
                  <span className="font-mono text-[11px] text-muted/60 shrink-0">
                    {relativeDate(ev.at)}
                    {ev.deckId ? ` · deck ${ev.deckId}` : ''}
                  </span>
                  {from && (
                    <span className="font-mono text-[11px] text-muted/50 truncate">
                      ← {from}
                    </span>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Running orders that include this track */}
      {trackOrders.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {trackOrders.map((o) => (
            <div key={o.id} className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent/50">N° {String(o.catalogNum).padStart(3,'0')}</span>
              <span className="font-mono text-[11px] text-muted/60 truncate">{o.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* Edit lineage */}
      {lineage?.isEdit ? (
        <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-border/15">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent/70 bg-accent/8 px-1.5 py-0.5 rounded shrink-0">
            edit
          </span>
          <span className="font-mono text-[12px] text-muted truncate">
            of {originalTrack
              ? (originalTrack.title || originalTrack.artist || 'unknown')
              : lineage.originalId?.slice(0, 8) + '…'}
          </span>
          <button onClick={handleClearEdit}
            className="ml-auto font-mono text-[11px] text-muted/50 hover:text-accent transition-colors shrink-0">
            clear
          </button>
        </div>
      ) : (
        <div className="mt-1.5 pt-1.5 border-t border-border/15">
          {showEditForm ? (
            <div className="space-y-1">
              <input
                autoFocus
                value={editSearch}
                onChange={(e) => setEditSearch(e.target.value)}
                placeholder="search for original track…"
                className="w-full bg-transparent border border-border/40 rounded px-2 py-1 font-mono text-[12px] text-ink placeholder:text-muted/40 focus:outline-none focus:border-accent/50"
              />
              {searchResults.length > 0 && (
                <div className="bg-chassis border border-border/30 rounded overflow-hidden">
                  {searchResults.map((t) => (
                    <button key={t.id} onClick={() => handleMarkAsEdit(t)}
                      className="w-full text-left px-2 py-1.5 hover:bg-accent/5 border-b border-border/20 last:border-b-0 space-y-0">
                      <p className="font-mono text-[12px] text-ink truncate">{t.title}</p>
                      <p className="font-mono text-[11px] text-muted truncate">{t.artist}</p>
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => { setShowEditForm(false); setEditSearch('') }}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors">
                cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setShowEditForm(true)}
              className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted/60 hover:text-accent transition-colors">
              + mark as edit of…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Spec({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  // Stacked silk-screen label over the value. The old side-by-side layout had
  // no column gutter, so a cell's value collided with its neighbour's label
  // ("120.3KEY") and long values truncated to nothing.
  return (
    <div className="py-1.5 border-b border-border/20 min-w-0">
      <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-muted leading-none mb-1">
        {label}
      </span>
      <span
        className={`block font-mono text-[13px] font-bold leading-tight truncate ${accent ? 'text-accent' : 'text-ink'}`}
        title={value}
      >
        {value}
      </span>
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
        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted">Mood</span>
        {mood != null && (
          <span className="font-mono text-[13px] font-bold text-ink">
            {MOOD_LABEL(mood)}
            <span className="text-muted font-normal ml-1.5">({mood > 0 ? '+' : ''}{mood.toFixed(2)})</span>
          </span>
        )}
        {mood == null && <span className="font-mono text-[13px] text-muted">—</span>}
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
          <span key={l} className="font-mono text-[10px] text-muted/50">{l}</span>
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
      const template = resolveCueTemplate(await window.api.settings.get())
      const cues = await generateCuesForFile(draft.filePath, downbeatsForTrack(draft), draft.phrases, template)
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
        <Field label="Year">
          <input type="number" min="1900" max="2099" step="1"
            value={draft.year ?? ''} onChange={(e) => set('year', e.target.value ? Number(e.target.value) : null)}
            placeholder="e.g. 2024" className={INPUT + ' tabular-nums'} />
        </Field>
        <Field label="Label">
          <input value={draft.label} onChange={(e) => set('label', e.target.value)}
            placeholder="record label…" className={INPUT} />
        </Field>
      </div>

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
          <span className="font-mono text-[13px] text-muted w-5 text-right">{draft.energy ?? '—'}</span>
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
          <p className="font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-muted">Cue Points</p>
          <button
            onClick={handleAutoCue}
            disabled={generatingCues}
            title="Analyse energy curve and auto-place structural cue points"
            className="flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 hover:bg-accent/20 disabled:opacity-40 text-accent font-mono text-[12px] uppercase tracking-[0.1em] rounded border border-accent/25 transition-colors"
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
          <p className="font-mono text-[12px] text-red-400">{cueError}</p>
        )}
        <CuePointList cuePoints={draft.cuePoints} onChange={(cues) => set('cuePoints', cues)} />
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block font-mono text-[12px] uppercase tracking-[0.15em] text-muted">{label}</label>
      {children}
    </div>
  )
}

const INPUT = 'w-full bg-paper border border-border/40 rounded px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors'

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
          <span key={tag} className="flex items-center gap-1 bg-accent/15 text-accent font-mono text-[12px] px-2 py-0.5 rounded">
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
          <span className="font-mono text-[12px] text-muted shrink-0 min-w-[60px] truncate" title={k}>{k}</span>
          <span className="font-mono text-[11px] text-muted/50 shrink-0">·</span>
          <input
            value={v}
            onChange={(e) => onChange({ ...tags, [k]: e.target.value })}
            className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[13px] text-ink focus:text-ink border-b border-transparent focus:border-accent/50 transition-colors py-0.5"
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
          className="shrink-0 px-2 py-1 bg-accent/10 hover:bg-accent/20 text-accent rounded font-mono text-[13px] transition-colors disabled:opacity-40"
        >+</button>
      </div>
      {entries.length === 0 && (
        <p className="font-mono text-[12px] text-muted/50 italic">no custom fields — add one above</p>
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
    return <p className="font-mono text-[12px] text-muted italic">no cue points</p>

  return (
    <div className="space-y-1">
      {[...hotcues, ...memory].map((cue, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: cue.color || '#D86A4A' }} />
          <span className="font-mono text-[12px] text-muted w-7 shrink-0">
            {cue.type === 'hotcue' ? `H${cue.index + 1}` : 'MEM'}
          </span>
          <span className="font-mono text-[12px] text-ink-soft tabular-nums w-12 shrink-0">{formatMs(cue.positionMs)}</span>
          <input
            value={cue.label}
            onChange={(e) => update({ ...cue, label: e.target.value })}
            placeholder="label…"
            className="flex-1 bg-transparent border-b border-border/30 focus:border-accent outline-none font-mono text-[13px] text-ink py-0.5"
          />
          {cue.confidence != null && (
            <span
              title={`auto-cue confidence ${Math.round(cue.confidence * 100)}%`}
              className="font-mono text-[10px] tabular-nums shrink-0 w-9 text-right"
              style={{ color: `rgb(var(--ink-rgb) / ${0.3 + 0.6 * Math.min(1, cue.confidence)})` }}
            >
              {Math.round(cue.confidence * 100)}%
            </span>
          )}
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
        <span className="font-mono text-[11px] text-muted leading-none">—</span>
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

// ── Next Mode scoring ─────────────────────────────────────────────────────────

interface ScoreFactor {
  name: string
  value: number   // 0–1
  label: string   // e.g. "♦ harmonic" "→ energy" "+1 nrg" "↗ build"
  color: string
}

interface NextResult {
  score: number
  factors: ScoreFactor[]
}

function nextModeScore(last: Track, candidate: Track): NextResult {
  const factors: ScoreFactor[] = []

  // 1. Harmonic — 0.30
  const harm = harmonicScore(last.key, candidate.key)
  factors.push({
    name: 'harmonic', value: harm,
    label: harm > 0.8 ? '♦ harmonic' : harm > 0.5 ? '~ key' : '✗ key',
    color: harm > 0.8 ? '#4A9B6F' : harm > 0.5 ? '#8A8474' : '#B86E72',
  })

  // 2. BPM — 0.25 (rewards mixable range, ±8%)
  let bpmVal = 0.5
  let bpmLabel = '— bpm'
  if (last.bpm != null && candidate.bpm != null) {
    const diff = Math.abs(candidate.bpm - last.bpm)
    const pct  = diff / last.bpm
    bpmVal  = pct < 0.03 ? 1.0 : pct < 0.06 ? 0.80 : pct < 0.10 ? 0.55 : Math.max(0, 1 - diff / 30)
    const sign = candidate.bpm > last.bpm ? '+' : candidate.bpm < last.bpm ? '-' : '='
    bpmLabel = `${sign}${diff.toFixed(0)} bpm`
  }
  factors.push({ name: 'bpm', value: bpmVal, label: bpmLabel, color: bpmVal > 0.7 ? '#C9A02C' : '#8A8474' })

  // 3. Energy continuity — 0.20 (±1.5 energy units = ideal)
  let nrgVal = 0.5
  let nrgLabel = '— nrg'
  if (last.energy != null && candidate.energy != null) {
    const diff = candidate.energy - last.energy
    nrgVal   = Math.abs(diff) <= 1.5 ? 1.0 : Math.abs(diff) <= 3 ? 0.60 : Math.max(0, 1 - Math.abs(diff) / 5)
    nrgLabel = diff === 0 ? '= nrg' : diff > 0 ? `+${diff.toFixed(0)} nrg` : `${diff.toFixed(0)} nrg`
  }
  factors.push({ name: 'energy', value: nrgVal, label: nrgLabel, color: nrgVal > 0.7 ? '#4E7090' : '#8A8474' })

  // 4. Mood continuity — 0.15
  let moodVal = 0.5
  let moodLabel = '— mood'
  if (last.mood != null && candidate.mood != null) {
    const diff = candidate.mood - last.mood
    moodVal   = Math.max(0, 1 - Math.abs(diff) / 1.5)
    moodLabel = Math.abs(diff) < 0.1 ? '→ mood' : diff > 0 ? '↑ mood' : '↓ mood'
  }
  factors.push({ name: 'mood', value: moodVal, label: moodLabel, color: moodVal > 0.7 ? '#9c27b0' : '#8A8474' })

  // 5. Momentum — 0.10 (slight build is good, big jump or drop = penalty)
  let momVal = 0.5
  let momLabel = '→'
  if (last.energy != null && candidate.energy != null) {
    const diff = candidate.energy - last.energy
    if (diff > 0 && diff <= 2)       { momVal = 1.0; momLabel = '↗ build' }
    else if (diff > 2)               { momVal = 0.5; momLabel = '↑↑ jump' }
    else if (diff >= -1 && diff <= 0){ momVal = 0.7; momLabel = '→ hold'  }
    else                             { momVal = 0.3; momLabel = '↘ drop'  }
  }
  factors.push({ name: 'momentum', value: momVal, label: momLabel, color: momVal > 0.7 ? '#D86A4A' : '#8A8474' })

  const score =
    harm   * 0.30 +
    bpmVal * 0.25 +
    nrgVal * 0.20 +
    moodVal * 0.15 +
    momVal  * 0.10

  return { score, factors }
}

// ── MixablePanel ──────────────────────────────────────────────────────────────

function MixablePanel({ track }: { track: Track }): JSX.Element | null {
  const allTracks = useLibraryStore((s) => s.tracks)
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const loadTrackB = useDeckBStore((s) => s.loadTrack)
  const deckATrack = useDeckAStore((s) => s.currentTrack)
  const [mode, setMode] = useState<'match' | 'next' | 'sound'>('match')
  const [showFactors, setShowFactors] = useState<string | null>(null)

  if (!track.bpm && !track.key) return null

  // MATCH mode — standard compatibility scoring
  const matchCandidates = allTracks
    .filter((t) => t.id !== track.id)
    .map((t) => ({ track: t, score: compatibilityScore(track, t), next: null as NextResult | null }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)

  // NEXT mode — directional scoring from `track` as the last played
  // Context: use deckA's current track (if different) as additional signal
  const nextCandidates = allTracks
    .filter((t) => t.id !== track.id && t.id !== deckATrack?.id)
    .map((t) => {
      const result = nextModeScore(track, t)
      return { track: t, score: result.score, next: result }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)

  // SOUND mode — audio-content similarity (needs embeddings)
  const soundCandidates = track.embedding
    ? findSimilar(
        track.embedding,
        allTracks.filter((t) => t.id !== track.id && t.embedding).map((t) => ({ item: t, vec: t.embedding! })),
        8
      ).map((r) => ({ track: r.item, score: r.score, next: null as NextResult | null }))
    : []

  const candidates = mode === 'match' ? matchCandidates : mode === 'next' ? nextCandidates : soundCandidates
  if (!candidates.length && mode !== 'sound') return null

  return (
    <div className="px-3 py-3 border-b border-border/30">
      {/* Header with MATCH / NEXT toggle */}
      <div className="flex items-center justify-between mb-2">
        <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted">
          <span className="text-accent mr-1">04</span>mixable tracks
        </p>
        <div className="flex items-center border border-border/35 rounded overflow-hidden">
          {(['match', 'next', 'sound'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                mode === m ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === 'next' && (
        <p className="font-mono text-[11px] text-muted/50 mb-1.5">
          what plays well <em>after</em> this track
        </p>
      )}

      {mode === 'sound' && (
        <p className="font-mono text-[11px] text-muted/50 mb-1.5">
          {track.embedding
            ? <>tracks that <em>sound like</em> this one</>
            : <>run “Audio similarity” in Analyse to enable this</>}
        </p>
      )}

      <div className="space-y-0.5">
        {candidates.map(({ track: t, score, next }) => (
          <div key={t.id} className="group">
            <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-ink/[0.05] transition-colors cursor-default">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] text-ink truncate">{t.title || '—'}</p>
                {/* Factor pills — Next Mode only */}
                {mode === 'next' && next && (
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {next.factors
                      .sort((a, b) => b.value - a.value)
                      .slice(0, 3)
                      .map((f) => (
                        <span
                          key={f.name}
                          className="font-mono text-[10px] uppercase tracking-[0.06em] px-1 py-px rounded"
                          style={{ color: f.color, background: f.color + '18' }}
                        >
                          {f.label}
                        </span>
                      ))
                    }
                  </div>
                )}
                {mode === 'match' && (
                  <p className="font-mono text-[12px] text-muted truncate">{t.artist}</p>
                )}
              </div>
              <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">{t.key ?? '—'}</span>
              <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">{t.bpm?.toFixed(0) ?? '—'}</span>
              {/* Score bar */}
              <div
                className="w-8 h-1 rounded-full shrink-0"
                title={`${mode === 'next' ? 'next' : 'match'}: ${Math.round(score * 100)}%`}
                style={{ background: `rgba(var(--accent-rgb), ${0.15 + score * 0.85})` }}
              />
              {/* Load buttons */}
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => loadTrackA(t)}
                  className="font-mono text-[11px] uppercase tracking-[0.1em] text-accent shrink-0"
                  title="Load to deck A"
                >A</button>
                <button
                  onClick={() => loadTrackB(t)}
                  className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted hover:text-ink shrink-0"
                  title="Load to deck B"
                >B</button>
              </div>
            </div>

            {/* Expandable full factor breakdown */}
            {mode === 'next' && next && showFactors === t.id && (
              <div className="mx-2 mb-1 px-2 py-1.5 bg-ink/[0.03] rounded border border-border/20 space-y-1">
                {next.factors.map((f) => (
                  <div key={f.name} className="flex items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted/50 w-14 shrink-0">{f.name}</span>
                    <div className="flex-1 h-0.5 bg-border/20 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${f.value * 100}%`, background: f.color }} />
                    </div>
                    <span className="font-mono text-[10px] shrink-0" style={{ color: f.color }}>{f.label}</span>
                    <span className="font-mono text-[10px] text-muted/40 tabular-nums shrink-0">{Math.round(f.value * 100)}%</span>
                  </div>
                ))}
                <p className="font-mono text-[10px] font-bold text-muted/60 pt-0.5">
                  total · {Math.round(next.score * 100)}%
                </p>
              </div>
            )}

            {/* Toggle breakdown on click in Next Mode */}
            {mode === 'next' && next && (
              <button
                onClick={() => setShowFactors(showFactors === t.id ? null : t.id)}
                className="w-full text-left px-4 font-mono text-[10px] text-muted/30 hover:text-muted/60 transition-colors"
              >
                {showFactors === t.id ? '▲ less' : '▼ why?'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
