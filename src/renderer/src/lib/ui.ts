/**
 * Shared UI class helpers — one source of truth for the recurring button and
 * tab treatments so pages stop hand-rolling slightly different variants.
 */

/** Segmented-control / dashboard tab pill. */
export function tabClass(active: boolean): string {
  return `font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1 rounded transition-colors ${
    active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink hover:bg-ink/[0.05]'
  }`
}

/** Solid accent call-to-action. */
export const btnPrimary =
  'font-mono text-[12px] uppercase tracking-[0.1em] px-4 py-1.5 rounded bg-accent hover:bg-accent/90 text-paper transition-colors disabled:opacity-40'

/** Bordered, low-emphasis action. */
export const btnGhost =
  'font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1 rounded border border-border/40 hover:border-border/70 text-muted hover:text-ink transition-colors disabled:opacity-40'
