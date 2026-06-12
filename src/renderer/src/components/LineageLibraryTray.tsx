/**
 * LineageLibraryTray — the bottom dock shown while the Lineage page is open
 * (replacing the deck zone). Hosts the compact LibraryMini table; drag a row
 * onto the Lineage stage to dig a crate from that track.
 */

import { LibraryMini } from './LibraryMini'

export function LineageLibraryTray(): JSX.Element {
  return (
    <div className="shrink-0 flex flex-col bg-chassis border-t border-border/30" style={{ height: 300 }}>
      <div className="shrink-0 flex items-center px-3" style={{ height: 24 }}>
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent">
          library — drag a track onto the web to dig
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <LibraryMini />
      </div>
    </div>
  )
}
