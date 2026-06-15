import { useState, useEffect, useRef } from 'react'
import { keyBlipColor } from '../../components/CamelotWheel'
import type { Playlist } from '@shared/types'
import { type ChapterProfile, fmt, fmtBpmRange, fmtEnergyRange, scoreColor } from './model'

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared: ChapterHeader ─────────────────────────────────────────────────────
// Shows profile stats + magic sort button + rename inline
// ═════════════════════════════════════════════════════════════════════════════

export function ChapterHeader({ chapter, profile, onMagicSort, onAiSequence, aiEnabled, aiBusy, onRename, onDelete, compact = false }: {
  chapter: Playlist; profile: ChapterProfile
  onMagicSort: () => void
  onAiSequence?: () => void; aiEnabled?: boolean; aiBusy?: boolean
  onRename: (name: string) => void; onDelete: () => void
  compact?: boolean
}): JSX.Element {
  const [renaming,  setRenaming]  = useState(false)
  const [draftName, setDraftName] = useState(chapter.name)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setDraftName(chapter.name) }, [chapter.name])
  useEffect(() => { if (renaming) inputRef.current?.focus() }, [renaming])

  const commit = () => {
    setRenaming(false)
    if (draftName.trim() && draftName !== chapter.name) onRename(draftName.trim())
    else setDraftName(chapter.name)
  }

  return (
    <div className={`flex items-center gap-2 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} border-b border-border/20 bg-chassis-soft`}>
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: chapter.color }} />

      {renaming ? (
        <input ref={inputRef} value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setRenaming(false); setDraftName(chapter.name) } }}
          onBlur={commit}
          className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none font-mono text-[13px] font-bold text-ink"
        />
      ) : (
        <span className="font-mono text-[13px] font-bold text-ink cursor-text flex-1 min-w-0 truncate"
          onDoubleClick={() => setRenaming(true)}>{chapter.name}</span>
      )}

      {/* Profile badges */}
      <div className="flex items-center gap-1.5 shrink-0">
        {profile.bpmAvg != null && (
          <span className="font-mono text-[11px] text-muted tabular-nums" title="BPM range">
            {fmtBpmRange(profile)}
          </span>
        )}
        {profile.energyAvg != null && (
          <span className="font-mono text-[11px] tabular-nums" title="Energy range"
            style={{ color: scoreColor(profile.energyAvg / 10) }}>
            {fmtEnergyRange(profile)}
          </span>
        )}
        {profile.keyCluster && (
          <span className="font-mono text-[11px] font-bold tabular-nums"
            style={{ color: keyBlipColor(profile.keyCluster) }} title="Key cluster">
            {profile.keyCluster}
          </span>
        )}
        <span className="font-mono text-[11px] text-muted/60 tabular-nums">{fmt(profile.duration)}</span>
      </div>

      {/* Magic sort */}
      <button onClick={(e) => { e.stopPropagation(); onMagicSort() }}
        title="Magic Sort — reorder by harmonic + energy compatibility"
        className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted hover:text-accent border border-border/35 hover:border-accent/40 rounded transition-colors">
        sort
      </button>

      {/* AI sequence */}
      {aiEnabled && onAiSequence && (
        <button onClick={(e) => { e.stopPropagation(); if (!aiBusy) onAiSequence() }}
          disabled={aiBusy}
          title="AI Sequence — reason about energy arc, harmonic flow & narrative"
          className="shrink-0 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-accent hover:text-ink border border-accent/30 hover:border-accent/60 rounded transition-colors disabled:opacity-40">
          {aiBusy ? '…' : '✦ ai'}
        </button>
      )}

      <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${chapter.name}"?`)) onDelete() }}
        className="shrink-0 text-muted/40 hover:text-red-500 transition-colors font-mono text-xs leading-none">×</button>
    </div>
  )
}
