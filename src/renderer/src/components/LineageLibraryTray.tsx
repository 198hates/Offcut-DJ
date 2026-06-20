/**
 * LineageLibraryTray — the bottom dock shown while the Lineage page is open
 * (replacing the deck zone). Two tabs:
 *   • Library — the compact LibraryMini table; drag a row onto the stage to dig.
 *   • Saved   — finds you've saved while digging (the crate); drag one back onto
 *               the stage to dig a fresh net from it.
 * The Lineage page emits `lineage:saved-changed` when the crate changes so the
 * Saved tab stays in sync.
 */

import { useCallback, useEffect, useState } from 'react'
import { LibraryMini } from './LibraryMini'
import { setSeedDragData } from '../lib/trackDrag'
import type { StoredCandidate } from '@shared/types'

type Tab = 'library' | 'saved'

export function LineageLibraryTray(): JSX.Element {
  const [tab, setTab] = useState<Tab>('library')
  const [saved, setSaved] = useState<StoredCandidate[]>([])

  const loadSaved = useCallback(() => {
    window.api.lineage
      .listSaved()
      .then(setSaved)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadSaved()
    window.addEventListener('lineage:saved-changed', loadSaved)
    return () => window.removeEventListener('lineage:saved-changed', loadSaved)
  }, [loadSaved])

  const hint =
    tab === 'library'
      ? 'drag a track onto the web to dig'
      : saved.length
        ? 'drag a saved find onto the web to dig from it'
        : 'save finds while digging — they collect here'

  return (
    <div className="shrink-0 flex flex-col bg-chassis border-t border-border/30" style={{ height: 300 }}>
      <div className="shrink-0 flex items-center gap-3 px-3" style={{ height: 26 }}>
        <button
          onClick={() => setTab('library')}
          className={`font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
            tab === 'library' ? 'text-accent' : 'text-muted hover:text-ink-soft'
          }`}
        >
          library
        </button>
        <button
          onClick={() => setTab('saved')}
          className={`font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${
            tab === 'saved' ? 'text-accent' : 'text-muted hover:text-ink-soft'
          }`}
        >
          saved{saved.length ? ` · ${saved.length}` : ''}
        </button>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60 ml-1">— {hint}</span>
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'library' ? <LibraryMini /> : <SavedFindsList finds={saved} />}
      </div>
    </div>
  )
}

function SavedFindsList({ finds }: { finds: StoredCandidate[] }): JSX.Element {
  if (finds.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-[12px] font-mono px-4 text-center">
        No saved finds yet. Hit ＋ Save on a track while digging and it lands here.
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      {finds.map((c) => (
        <div
          key={c.key}
          draggable
          onDragStart={(e) => setSeedDragData(e, { artist: c.artist, title: c.title })}
          title="Drag onto the web to dig from this find"
          className="flex items-center gap-3 px-3 py-1.5 border-b border-border/15 cursor-grab hover:bg-ink/[0.05]"
        >
          <span className="font-mono text-[10px] text-accent w-7 shrink-0 text-right tabular-nums">
            {Math.round(c.score)}
          </span>
          <span className="text-[12px] text-ink truncate flex-1 min-w-0">{c.title || '—'}</span>
          <span className="text-[11px] text-muted truncate w-[34%] shrink-0">{c.artist || '—'}</span>
          {c.year != null && <span className="font-mono text-[10px] text-muted/60 shrink-0">{c.year}</span>}
        </div>
      ))}
    </div>
  )
}
