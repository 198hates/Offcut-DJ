import type { ReactNode } from 'react'

/**
 * Shared page header bar. One consistent treatment across sub-pages: a compact
 * uppercase title with an accent marker, an optional muted subtitle, and an
 * optional right-aligned slot for actions or live meta.
 */
export function PageHeader({
  marker,
  title,
  subtitle,
  right
}: {
  marker?: string
  title: string
  subtitle?: ReactNode
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="px-5 pt-4 pb-2.5 border-b border-border/20 shrink-0 flex items-center gap-4">
      <p className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-muted whitespace-nowrap">
        {marker && <span className="text-accent mr-1.5">{marker}</span>}
        {title}
      </p>
      {subtitle && (
        <span className="font-mono text-[11px] text-muted/50 truncate">{subtitle}</span>
      )}
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  )
}
