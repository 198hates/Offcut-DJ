export type Section = 'library' | 'sync' | 'analyse' | 'health' | 'fixes' | 'builder' | 'compass' | 'orders' | 'search' | 'prolink' | 'lineage' | 'assistant' | 'usb' | 'settings'

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

/** Search — magnifier: advanced multi-dimension search */
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.5"/>
      <line x1="10" y1="10" x2="14" y2="14"/>
    </svg>
  )
}

/** Orders — numbered document list: running orders */
function OrdersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {/* Numbered list lines */}
      <line x1="5.5" y1="3.5"  x2="14"  y2="3.5"/>
      <line x1="5.5" y1="8"    x2="14"  y2="8"/>
      <line x1="5.5" y1="12.5" x2="14"  y2="12.5"/>
      {/* Number markers */}
      <text x="1.5" y="5"    fontFamily="monospace" fontSize="4" fill="currentColor" stroke="none">1</text>
      <text x="1.5" y="9.5"  fontFamily="monospace" fontSize="4" fill="currentColor" stroke="none">2</text>
      <text x="1.5" y="14"   fontFamily="monospace" fontSize="4" fill="currentColor" stroke="none">3</text>
    </svg>
  )
}

/** Compass — scatter dot: library spatial map */
function CompassIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {/* Crosshair circle */}
      <circle cx="8" cy="8" r="5.5"/>
      <line x1="8" y1="2" x2="8" y2="4.5"/>
      <line x1="8" y1="11.5" x2="8" y2="14"/>
      <line x1="2" y1="8" x2="4.5" y2="8"/>
      <line x1="11.5" y1="8" x2="14" y2="8"/>
      {/* Scatter dots */}
      <circle cx="6"  cy="6.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="5.5" r="1" fill="currentColor" stroke="none"/>
      <circle cx="7"  cy="10" r="1" fill="currentColor" stroke="none"/>
      <circle cx="11" cy="9.5" r="1" fill="currentColor" stroke="none"/>
    </svg>
  )
}

/** ProLink — broadcast tower: live ProLink network capture */
function ProLinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* Tower mast */}
      <line x1="8" y1="5" x2="8" y2="14.5"/>
      {/* Base legs */}
      <line x1="8" y1="14.5" x2="5" y2="14.5"/>
      <line x1="8" y1="14.5" x2="11" y2="14.5"/>
      {/* Signal arcs — inner */}
      <path d="M5.6 7.4 A3.4 3.4 0 0 1 10.4 7.4" strokeLinecap="round"/>
      {/* Signal arcs — outer */}
      <path d="M3.4 5.0 A6.1 6.1 0 0 1 12.6 5.0" strokeLinecap="round"/>
      {/* Tip dot */}
      <circle cx="8" cy="4" r="1" fill="currentColor" stroke="none"/>
    </svg>
  )
}

/** Lineage — a record crate: library expansion / crate-digging */
function LineageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="4" width="11" height="9" rx="1" />
      <line x1="2.5" y1="6.3" x2="13.5" y2="6.3" />
      <circle cx="8" cy="9.6" r="2.1" />
      <circle cx="8" cy="9.6" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** USB — a memory-stick: prepare Rekordbox USBs */
function UsbIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {/* body */}
      <rect x="5" y="6" width="6" height="9" rx="1" />
      {/* connector */}
      <rect x="6.25" y="2" width="3.5" height="4" rx="0.5" />
      {/* contacts */}
      <line x1="7" y1="3.2" x2="7" y2="4.6" />
      <line x1="9" y1="3.2" x2="9" y2="4.6" />
    </svg>
  )
}

/** Assistant — chat bubble with a spark: conversational AI agent */
function AssistantIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
      <path d="M8 5.2 8.7 7 10.5 7.7 8.7 8.4 8 10.2 7.3 8.4 5.5 7.7 7.3 7 8 5.2Z" fill="currentColor" stroke="none" />
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
  { id: 'search',  Icon: SearchIcon,  label: 'Advanced Search' },
  { id: 'orders',  Icon: OrdersIcon,   label: 'Running Orders'  },
  { id: 'compass', Icon: CompassIcon,  label: 'Library Compass' },
  { id: 'prolink', Icon: ProLinkIcon,  label: 'ProLink Capture' },
  { id: 'lineage',   Icon: LineageIcon,    label: 'Lineage'    },
  { id: 'assistant', Icon: AssistantIcon,  label: 'Assistant'  },
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
      <button onClick={() => onNavigate('usb')} title="USB Export" className={`${cls('usb')} mb-1`}>
        <UsbIcon />
      </button>
      <button onClick={() => onNavigate('settings')} title="Settings" className={cls('settings')}>
        <GearIcon />
      </button>
    </div>
  )
}
