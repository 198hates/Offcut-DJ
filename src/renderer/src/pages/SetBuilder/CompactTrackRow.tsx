import { keyBlipColor } from '../../components/CamelotWheel'
import { useTrackMenuContext } from '../../hooks/useTrackMenu'
import type { Track } from '@shared/types'
import { fmt, scoreColor } from './model'

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared: CompactTrackRow ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export function CompactTrackRow({ track, index, accentColor, fitScoreVal, isSeed, onLoad, onRemove, onSetSeed }: {
  track: Track; index: number; accentColor: string
  fitScoreVal: number | null; isSeed: boolean
  onLoad: () => void; onRemove: () => void; onSetSeed: () => void
}): JSX.Element {
  const keyColor = keyBlipColor(track.key)
  const openTrackMenu = useTrackMenuContext()
  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 border-b border-border/15 hover:bg-ink/[0.04] transition-colors ${isSeed ? 'bg-accent/[0.06]' : ''}`}
      style={{ borderLeftColor: accentColor, borderLeftWidth: 2 }}
      onDoubleClick={onLoad}
      onContextMenu={(e) => openTrackMenu(e, {
        ids: [track.id], track,
        remove: { label: 'Remove from chapter', action: onRemove }
      })}
    >
      <span className="font-mono text-[12px] text-muted/50 tabular-nums w-4 text-right shrink-0">{index}</span>

      {/* Seed toggle */}
      <button
        onClick={onSetSeed}
        title={isSeed ? 'Seeding suggestions from this track' : 'Use as seed for suggestions'}
        className={`shrink-0 text-xs leading-none transition-colors ${isSeed ? 'text-accent' : 'text-muted/30 hover:text-accent/60'}`}
      >⊕</button>

      <div className="flex-1 min-w-0">
        <p className="font-mono text-[13px] text-ink truncate leading-snug">{track.title || '—'}</p>
        <p className="font-mono text-[12px] text-muted truncate leading-snug">{track.artist}</p>
      </div>

      {track.bpm  != null && <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">{track.bpm.toFixed(0)}</span>}
      {track.key  && <span className="font-mono text-[12px] font-bold tabular-nums shrink-0" style={{ color: keyColor }}>{track.key}</span>}
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0 hidden sm:inline">{fmt(track.durationSeconds)}</span>

      {/* Fit score bar */}
      {fitScoreVal != null && (
        <div className="w-8 h-1 bg-border/20 rounded-full overflow-hidden shrink-0" title={`Fit: ${Math.round(fitScoreVal * 100)}%`}>
          <div className="h-full rounded-full transition-all" style={{ width: `${fitScoreVal * 100}%`, background: scoreColor(fitScoreVal) }} />
        </div>
      )}

      <button onClick={onRemove}
        className="shrink-0 opacity-0 group-hover:opacity-100 text-muted/50 hover:text-red-500 transition-all font-mono text-xs leading-none">×</button>
    </div>
  )
}
