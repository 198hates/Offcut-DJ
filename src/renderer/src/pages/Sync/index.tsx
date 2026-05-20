import { useLibraryStore } from '../../store/libraryStore'
import { RekordboxSync } from '../../components/RekordboxSync'
import type { IntegrationId } from '@shared/types'

const INTEGRATIONS: { id: IntegrationId; label: string; canImport: boolean; canExport: boolean }[] = [
  { id: 'rekordbox',   label: 'Rekordbox',   canImport: true,  canExport: true  },
  { id: 'traktor',     label: 'Traktor',     canImport: true,  canExport: true  },
  { id: 'serato',      label: 'Serato',      canImport: true,  canExport: true  },
  { id: 'apple-music', label: 'Apple Music', canImport: true,  canExport: false },
  { id: 'engine-dj',   label: 'Engine DJ',   canImport: true,  canExport: true  },
  { id: 'virtualdj',   label: 'VirtualDJ',   canImport: false, canExport: true  },
  { id: 'm3u',         label: 'M3U',         canImport: false, canExport: true  },
]

function SectionLabel({ num, label }: { num: string; label: string }): JSX.Element {
  return (
    <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted mb-3">
      <span className="text-accent mr-1">{num}</span>{label}
    </p>
  )
}

function IntegrationGrid({ ids, busy, busyLabel, onClick }: {
  ids: { id: IntegrationId; label: string }[]
  busy: boolean
  busyLabel: string
  onClick: (id: IntegrationId) => void
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ids.map((i) => (
        <button
          key={i.id}
          onClick={() => onClick(i.id)}
          disabled={busy}
          className="flex items-center justify-center px-3 py-3 rounded border border-border/40 font-mono text-[11px] text-ink-soft hover:bg-ink/[0.05] hover:text-ink hover:border-border/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {busy ? busyLabel : i.label}
        </button>
      ))}
    </div>
  )
}

export function SyncPage(): JSX.Element {
  const { importFromIntegration, exportToIntegration, stats, isImporting, isExporting } = useLibraryStore()

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-5 pt-4 pb-2.5 border-b border-border/20 shrink-0">
        <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
          <span className="text-accent mr-1">02</span>sync
        </p>
      </div>

      <div className="px-5 py-5 space-y-8 max-w-lg">
        {/* Import */}
        <section>
          <SectionLabel num="↓" label="import" />
          <IntegrationGrid
            ids={INTEGRATIONS.filter((i) => i.canImport)}
            busy={isImporting}
            busyLabel="importing…"
            onClick={(id) => importFromIntegration(id)}
          />
        </section>

        {/* Export */}
        <section>
          <div className="flex items-baseline gap-3 mb-3">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
              <span className="text-accent mr-1">↑</span>export
            </p>
            {stats?.trackCount ? (
              <span className="font-mono text-[9px] text-muted/60 tabular-nums">
                {stats.trackCount.toLocaleString()} tracks
              </span>
            ) : null}
          </div>
          <IntegrationGrid
            ids={INTEGRATIONS.filter((i) => i.canExport)}
            busy={isExporting}
            busyLabel="exporting…"
            onClick={(id) => exportToIntegration(id)}
          />
        </section>

        {/* Live sync */}
        <section>
          <SectionLabel num="↕" label="live sync" />
          <RekordboxSync />
        </section>
      </div>
    </div>
  )
}
