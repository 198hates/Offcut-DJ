import { useLibraryStore } from '../store/libraryStore'
import { useDeckAStore } from '../store/playerStore'

// ── Icon SVGs (1.8px stroke, 24×24 viewBox) ─────────────────────────────────

const ICONS: Record<string, JSX.Element> = {
  harmonic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <circle cx="12" cy="12" r="4.5"/>
      <line x1="12" y1="3" x2="12" y2="7.5"/>
      <line x1="12" y1="16.5" x2="12" y2="21"/>
      <line x1="3" y1="12" x2="7.5" y2="12"/>
      <line x1="16.5" y1="12" x2="21" y2="12"/>
    </svg>
  ),
  range: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M6 4v16M18 4v16"/>
      <path d="M6 4h3M6 20h3M15 4h3M15 20h3"/>
      <line x1="6" y1="12" x2="18" y2="12"/>
    </svg>
  ),
  rating: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <polygon points="12,3 14.6,9.2 21,10 16,14.5 17.4,21 12,17.5 6.6,21 8,14.5 3,10 9.4,9.2"/>
    </svg>
  ),
  unplayed: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  new: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13,2 4,14 12,14 11,22 20,10 12,10"/>
    </svg>
  ),
  energy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="4" y1="20" x2="4" y2="16"/>
      <line x1="9" y1="20" x2="9" y2="12"/>
      <line x1="14" y1="20" x2="14" y2="8"/>
      <line x1="19" y1="20" x2="19" y2="4"/>
    </svg>
  ),
  analysed: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17 C 7 17, 8 7, 12 7 S 17 17, 21 17"/>
      <circle cx="3" cy="17" r="1.2" fill="currentColor"/>
      <circle cx="12" cy="7" r="1.2" fill="currentColor"/>
      <circle cx="21" cy="17" r="1.2" fill="currentColor"/>
    </svg>
  ),
  cued: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l14 9-14 9V3z"/>
      <line x1="19" y1="12" x2="22" y2="12"/>
    </svg>
  ),
}

const CELLS: { key: string; label: string; needsContext?: 'harmonic' | 'range' }[] = [
  { key: 'harmonic', label: 'harmonic',  needsContext: 'harmonic' },
  { key: 'range',    label: 'bpm ±4%',   needsContext: 'range'    },
  { key: 'rating',   label: '★★★+'                               },
  { key: 'unplayed', label: 'unplayed'                            },
  { key: 'new',      label: 'new · 7d'                            },
  { key: 'energy',   label: 'energy 7+'                           },
  { key: 'analysed', label: 'analysed'                            },
]

export function FnBus(): JSX.Element {
  const { fnBus, fnBusContext, toggleFnBus, resetFnBus, filteredTracks } = useLibraryStore()
  const deckABpm     = useDeckAStore((s) => s.currentTrack?.bpm ?? null)
  const deckAKey     = useDeckAStore((s) => s.currentTrack?.key ?? null)

  const filteredCount = filteredTracks().length
  const anyActive = fnBus.size > 0

  const handleToggle = (key: string, needsContext?: 'harmonic' | 'range') => {
    if (!fnBus.has(key) && needsContext === 'harmonic' && deckAKey) {
      toggleFnBus(key, { harmonicKey: deckAKey })
    } else if (!fnBus.has(key) && needsContext === 'range' && deckABpm) {
      toggleFnBus(key, { bpmRef: deckABpm })
    } else {
      toggleFnBus(key)
    }
  }

  return (
    <div className="shrink-0 flex items-stretch bg-chassis-soft border-b border-border/30" style={{ height: 52 }}>
      {/* Bus label */}
      <div className="flex items-center px-3 border-r border-border/30">
        <span className="font-mono text-[8px] font-bold uppercase tracking-[0.22em] text-muted"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          <span className="text-accent">fn</span>·bus
        </span>
      </div>

      {/* Cells */}
      <div className="flex flex-1">
        {CELLS.map(({ key, label, needsContext }) => {
          const on = fnBus.has(key)
          const disabled = (needsContext === 'harmonic' && !deckAKey && !on) ||
                           (needsContext === 'range'    && !deckABpm  && !on)
          return (
            <button
              key={key}
              onClick={() => !disabled && handleToggle(key, needsContext)}
              title={
                needsContext === 'harmonic'
                  ? on
                    ? `harmonic: filtering for keys compatible with ${fnBusContext.harmonicKey}`
                    : deckAKey
                    ? `filter keys compatible with deck A (${deckAKey})`
                    : 'load a track on deck A first'
                  : needsContext === 'range'
                  ? on
                    ? `bpm range: within ±4% of ${fnBusContext.bpmRef?.toFixed(1)} bpm`
                    : deckABpm
                    ? `filter tracks within ±4% of deck A bpm (${deckABpm.toFixed(1)})`
                    : 'load a track on deck A first'
                  : label
              }
              className={`flex flex-col items-center justify-center flex-1 border-r border-border/25 relative transition-colors select-none min-w-0
                ${on        ? 'bg-accent/[0.07]' : 'hover:bg-ink/[0.03]'}
                ${disabled  ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {/* Corner LED */}
              <div
                className="absolute top-1.5 right-2"
                style={{
                  width: 4, height: 4,
                  borderRadius: '50%',
                  background: on ? 'rgb(var(--accent-rgb))' : 'rgb(var(--border-rgb))',
                  opacity: on ? 1 : 0.4,
                  boxShadow: on ? '0 0 6px rgb(var(--accent-rgb))' : 'none',
                }}
              />

              {/* Icon */}
              <div
                className="w-[18px] h-[18px] mb-0.5"
                style={{ color: on ? 'rgb(var(--accent-rgb))' : 'rgb(var(--muted-rgb))' }}
              >
                {ICONS[key]}
              </div>

              {/* Label */}
              <span
                className="font-mono leading-none"
                style={{
                  fontSize: 8,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  color: on ? 'rgb(var(--ink-rgb))' : 'rgb(var(--muted-rgb))',
                }}
              >
                {label}
              </span>
            </button>
          )
        })}
      </div>

      {/* LED display — BPM · KEY using proven led-readout CSS */}
      <div
        className="shrink-0 flex flex-col justify-center gap-1.5 px-3 border-l border-border/30 overflow-hidden"
        style={{ background: '#0d0d14', minWidth: 148 }}
      >
        {/* Two side-by-side led-readout boxes */}
        <div className="flex gap-2 justify-end">
          <div className="led-readout">
            <div className="led-readout-ghost" style={{ fontSize: 15 }}>888.8</div>
            <div className="led-readout-val" style={{ fontSize: 15 }}>
              {deckABpm ? deckABpm.toFixed(1) : '—.—'}
            </div>
            <span className="led-readout-label">bpm</span>
          </div>
          <div className="led-readout">
            <div className="led-readout-ghost" style={{ fontSize: 15 }}>88</div>
            <div className="led-readout-val" style={{ fontSize: 15 }}>
              {deckAKey ?? '—'}
            </div>
            <span className="led-readout-label">key</span>
          </div>
        </div>
        {/* Track count */}
        <div className="flex items-center justify-between">
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 7.5, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)' }}>
            {anyActive ? 'filtered' : 'trks'}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono'", fontSize: 10, letterSpacing: '0.05em', color: 'var(--led-text)', textShadow: '0 0 4px var(--led-glow)' }}>
            {filteredCount}
          </span>
        </div>
        {anyActive && (
          <button
            onClick={resetFnBus}
            style={{ fontFamily: "'JetBrains Mono'", fontSize: 7.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(216,106,74,0.6)', textAlign: 'right' }}
            className="hover:opacity-100 transition-opacity w-full"
          >
            clear
          </button>
        )}
      </div>
    </div>
  )
}
