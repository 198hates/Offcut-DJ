export type Section = 'library' | 'sync' | 'analyse' | 'health' | 'fixes' | 'builder' | 'settings'

interface Props {
  active: Section
  onNavigate: (s: Section) => void
}

function LibIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2" y="3"    width="12" height="1.5" rx="0.5"/>
      <rect x="2" y="7.25" width="12" height="1.5" rx="0.5"/>
      <rect x="2" y="11.5" width="12" height="1.5" rx="0.5"/>
    </svg>
  )
}

function SyncIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5A5.5 5.5 0 0 0 3.5 8"/>
      <path d="M4 11.5A5.5 5.5 0 0 0 12.5 8"/>
      <polyline points="12,2 12,4.5 9.5,4.5"/>
      <polyline points="4,14 4,11.5 6.5,11.5"/>
    </svg>
  )
}

/** Analyse — lightning bolt: automated processing */
function AnalyseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.5 1.5 L4.5 8.5 H8.5 L6.5 14.5 L11.5 7.5 H7.5 Z"/>
    </svg>
  )
}

/** Health — pulse line: library scan / maintenance */
function HealthIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="0.5,8 3.5,8 5,4.5 7,11.5 9,5.5 10.5,8 15.5,8"/>
    </svg>
  )
}

/** Fixes — wand with sparkle: metadata correction */
function FixesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Wand stem */}
      <line x1="9" y1="7" x2="2.5" y2="13.5"/>
      {/* Wand tip block */}
      <rect x="9" y="3.5" width="5" height="4" rx="0.5" fill="currentColor" stroke="none"/>
      {/* Sparkle lines */}
      <line x1="11.5" y1="1" x2="11.5" y2="2.5"/>
      <line x1="14.5" y1="3" x2="13.3" y2="3.7"/>
      <line x1="15" y1="6" x2="13.5" y2="6"/>
    </svg>
  )
}

function BuilderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1"   y="8"   width="3.5" height="5"   rx="0.5"/>
      <rect x="5.5" y="5"   width="5"   height="8"   rx="0.5"/>
      <rect x="11.5" y="7"  width="3.5" height="6"   rx="0.5"/>
      <rect x="1"   y="14"  width="14"  height="1"   rx="0.4"/>
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2"/>
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.88.88M11.72 11.72l.88.88M11.72 4.28l-.88.88M4.28 11.72l-.88.88"/>
    </svg>
  )
}

const MAIN_ITEMS: { id: Exclude<Section, 'settings'>; Icon: () => JSX.Element; label: string }[] = [
  { id: 'library', Icon: LibIcon,     label: 'Library'         },
  { id: 'sync',    Icon: SyncIcon,    label: 'Sync'            },
  { id: 'analyse', Icon: AnalyseIcon, label: 'Analyse'         },
  { id: 'health',  Icon: HealthIcon,  label: 'Library Health'  },
  { id: 'fixes',   Icon: FixesIcon,   label: 'Smart Fixes'     },
  { id: 'builder', Icon: BuilderIcon, label: 'Set Builder'     },
]

export function NavRail({ active, onNavigate }: Props): JSX.Element {
  const cls = (id: Section) =>
    `w-8 h-8 flex items-center justify-center rounded transition-colors ${
      active === id
        ? 'bg-accent/15 text-accent'
        : 'text-muted hover:text-ink hover:bg-ink/[0.07]'
    }`

  return (
    <div className="w-11 shrink-0 flex flex-col items-center bg-chassis border-r border-border/30 py-2">
      <div className="flex flex-col items-center gap-1 flex-1 pt-1">
        {MAIN_ITEMS.map(({ id, Icon, label }) => (
          <button key={id} onClick={() => onNavigate(id)} title={label} className={cls(id)}>
            <Icon />
          </button>
        ))}
      </div>
      <button onClick={() => onNavigate('settings')} title="Settings" className={cls('settings')}>
        <GearIcon />
      </button>
    </div>
  )
}
