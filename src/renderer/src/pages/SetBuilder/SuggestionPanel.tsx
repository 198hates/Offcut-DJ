import { useState, useMemo } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { keyBlipColor } from '../../components/CamelotWheel'
import type { Track } from '@shared/types'
import { type Suggestion, scoreColor } from './model'

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared: SuggestionPanel ───────────────────────────────────────────────────
// Seed mode (ranked by compatibility) + Search mode (text filter)
// ═════════════════════════════════════════════════════════════════════════════

export function SuggestionPanel({ chapterId, suggestions, seedTrack, onSetSeed, onAdd, compact }: {
  chapterId: string
  suggestions: Suggestion[]
  seedTrack: Track | null
  onSetSeed: (t: Track | null) => void
  onAdd: (chapterId: string, ids: string[]) => Promise<void>
  compact?: boolean
}): JSX.Element {
  const allTracks   = useLibraryStore((s) => s.tracks)
  const chapterPl   = useLibraryStore((s) => s.playlists.find((p) => p.id === chapterId))
  const existingIds = useMemo(() => new Set(chapterPl?.trackIds ?? []), [chapterPl])

  const [mode,  setMode]  = useState<'suggest' | 'search'>('suggest')
  const [query, setQuery] = useState('')
  const [open,  setOpen]  = useState(false)

  // Search results
  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return allTracks
      .filter((t) => !existingIds.has(t.id))
      .filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q)
      )
      .slice(0, compact ? 6 : 12)
  }, [allTracks, query, existingIds, compact])

  const items: { track: Track; score: number | null }[] = mode === 'suggest'
    ? suggestions.map((s) => ({ track: s.track, score: s.score }))
    : searchResults.map((t) => ({ track: t, score: null }))

  return (
    <div className={`shrink-0 border-t border-border/20 ${compact ? '' : ''}`}>
      {/* Mode toggle + seed indicator */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/15">
        <button onClick={() => setMode('suggest')}
          className={`px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] rounded transition-colors ${mode === 'suggest' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
          ✨ suggest
        </button>
        <button onClick={() => setMode('search')}
          className={`px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] rounded transition-colors ${mode === 'search' ? 'bg-ink/10 text-ink' : 'text-muted hover:text-ink'}`}>
          🔍 search
        </button>
        {seedTrack && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="font-mono text-[11px] text-accent/70 truncate max-w-[100px]"
              title={`Seed: ${seedTrack.title}`}>seed: {seedTrack.title || seedTrack.artist}</span>
            <button onClick={() => onSetSeed(null)} className="text-muted/50 hover:text-red-400 font-mono text-xs">×</button>
          </div>
        )}
      </div>

      {/* Search input (search mode) */}
      {mode === 'search' && (
        <div className="px-2 py-1">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="search library to add…"
            className={`w-full bg-paper border border-border/35 rounded px-2 py-1 font-mono outline-none focus:border-accent transition-colors placeholder-muted/50 ${compact ? 'text-[12px]' : 'text-[13px]'}`}
          />
        </div>
      )}

      {/* Seed mode — no seed yet */}
      {mode === 'suggest' && !seedTrack && (
        <div className="px-3 py-3 text-center">
          <p className="font-mono text-[12px] text-muted/60 italic">
            Click ⊕ on any track above to seed suggestions
          </p>
        </div>
      )}

      {/* Results */}
      {((mode === 'suggest' && seedTrack) || (mode === 'search' && open && query)) && items.length > 0 && (
        <div className={`overflow-y-auto ${compact ? 'max-h-32' : 'max-h-48'}`}>
          {items.map(({ track, score }) => (
            <div key={track.id}
              className="flex items-center gap-2 px-2 py-1 hover:bg-ink/[0.06] cursor-pointer border-b border-border/10 last:border-0"
              onMouseDown={() => onAdd(chapterId, [track.id])}>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[12px] text-ink truncate">{track.title || '—'}</p>
                <p className="font-mono text-[11px] text-muted truncate">{track.artist}</p>
              </div>
              {track.bpm != null && <span className="font-mono text-[12px] text-muted shrink-0 tabular-nums">{track.bpm.toFixed(0)}</span>}
              {track.key && (
                <span className="font-mono text-[12px] font-bold shrink-0 tabular-nums" style={{ color: keyBlipColor(track.key) }}>{track.key}</span>
              )}
              {score != null && (
                <div className="w-8 h-1 bg-border/20 rounded-full overflow-hidden shrink-0" title={`Match: ${Math.round(score * 100)}%`}>
                  <div className="h-full rounded-full" style={{ width: `${score * 100}%`, background: scoreColor(score) }} />
                </div>
              )}
              <span className="text-accent/50 font-mono text-[12px] shrink-0">+</span>
            </div>
          ))}
        </div>
      )}

      {mode === 'suggest' && seedTrack && items.length === 0 && (
        <div className="px-3 py-2">
          <p className="font-mono text-[12px] text-muted/50 italic">No suggestions — library may need BPM/key analysis</p>
        </div>
      )}
    </div>
  )
}
