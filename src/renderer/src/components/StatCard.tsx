/**
 * StatCard — a labelled metric tile used by the Analyse and Health dashboards.
 * `accent` highlights the value; `tone` picks the highlight colour
 * (theme accent for "of note", amber for "needs attention").
 */
export function StatCard({
  label,
  value,
  sub,
  accent,
  tone = 'accent'
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
  tone?: 'accent' | 'amber'
}): JSX.Element {
  const amber = accent && tone === 'amber'
  return (
    <div
      className={`border rounded p-3 space-y-0.5 ${
        amber ? 'bg-amber-500/[0.06] border-amber-500/25' : 'bg-ink/[0.03] border-border/25'
      }`}
    >
      <p className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p
        className={`font-mono text-lg font-bold tabular-nums ${
          amber ? 'text-amber-400' : accent ? 'text-accent' : 'text-ink'
        }`}
      >
        {value}
      </p>
      {sub && <p className="font-mono text-[12px] text-muted/70">{sub}</p>}
    </div>
  )
}
