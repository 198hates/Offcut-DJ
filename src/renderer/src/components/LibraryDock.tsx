/**
 * LibraryDock — a collapsible right-hand dock that hosts the LibraryMini table.
 * Mounted on pages that benefit from dragging tracks in (Running Orders, Set
 * Builder). Collapses to a thin spine so it can be tucked away.
 */

import { useState } from 'react'
import { LibraryMini } from './LibraryMini'

export function LibraryDock(): JSX.Element {
  const [open, setOpen] = useState(true)

  if (!open) {
    return (
      <div className="shrink-0 w-7 border-l border-border/30 bg-chassis flex flex-col items-center pt-2">
        <button
          onClick={() => setOpen(true)}
          title="Show library"
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted hover:text-accent transition-colors"
          style={{ writingMode: 'vertical-rl' }}
        >
          ‹ Library
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 w-[320px] border-l border-border/30 bg-chassis flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-2 py-1.5 border-b border-border/30">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent">Library</span>
        <button
          onClick={() => setOpen(false)}
          title="Collapse library"
          className="font-mono text-[13px] leading-none text-muted/50 hover:text-ink transition-colors px-1"
        >
          ›
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <LibraryMini />
      </div>
    </div>
  )
}
