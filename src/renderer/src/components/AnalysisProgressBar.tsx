/**
 * AnalysisProgressBar — global progress indicator for the shared analysisStore.
 *
 * Mounted once in App so any page that kicks off analysis from its right-click
 * menu gets the same floating progress readout, anchored above the player bar.
 */

import { createPortal } from 'react-dom'
import { useAnalysisStore } from '../store/analysisStore'

export function AnalysisProgressBar(): JSX.Element | null {
  const progress = useAnalysisStore((s) => s.progress)
  if (!progress) return null

  const pct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0

  return createPortal(
    <div className="fixed bottom-[88px] left-1/2 -translate-x-1/2 z-[9998] w-[min(420px,90vw)]
                    px-3 py-2 rounded-lg border border-accent/30 bg-chassis/95 backdrop-blur
                    shadow-2xl flex items-center gap-3">
      <span className="font-mono text-[12px] text-accent uppercase tracking-[0.12em] shrink-0 w-16">
        {progress.label}
      </span>
      <div className="flex-1 h-0.5 bg-border/30 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[12px] text-muted tabular-nums shrink-0">
        {progress.current}/{progress.total}
      </span>
      <span className="font-mono text-[12px] text-muted/60 truncate" style={{ maxWidth: 140 }}>
        {progress.track}
      </span>
    </div>,
    document.body
  )
}
