/**
 * MidiSettings — learn-mode MIDI mapping table for the Settings page.
 *
 * Displays every mappable action grouped by deck and function type.
 * Each row shows the current mapping (or —) plus Learn / Clear buttons.
 * Pressing Learn puts the engine into learn mode for that action;
 * the next non-note-off MIDI message is captured and stored.
 */
import { useEffect } from 'react'
import {
  useMidiStore,
  MIDI_ACTIONS,
  type MidiActionDef,
  type MidiActionGroup,
} from '../store/midiStore'

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMapping(m: { channel: number; messageType: string; number: number } | undefined): string {
  if (!m) return '—'
  if (m.messageType === 'pitchbend') return `Ch${m.channel + 1} Pitchbend`
  const type = m.messageType === 'note' ? 'Note' : 'CC'
  return `Ch${m.channel + 1} ${type} ${m.number}`
}

const GROUP_LABELS: Record<MidiActionGroup, string> = {
  transport: 'Transport',
  hotcues:   'Hot Cues',
  loops:     'Loops',
  channel:   'Channel Strip',
  mixer:     'Mixer',
}

// ── Action row ───────────────────────────────────────────────────────────────

function ActionRow({ action }: { action: MidiActionDef }): JSX.Element {
  const mapping         = useMidiStore((s) => s.mappings[action.id])
  const learningId      = useMidiStore((s) => s.learningActionId)
  const startLearning   = useMidiStore((s) => s.startLearning)
  const stopLearning    = useMidiStore((s) => s.stopLearning)
  const clearMapping    = useMidiStore((s) => s.clearMapping)

  const isLearning = learningId === action.id

  // ESC cancels learn
  useEffect(() => {
    if (!isLearning) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') stopLearning() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isLearning, stopLearning])

  return (
    <div
      className={`flex items-center gap-3 px-3 py-1.5 rounded transition-colors ${
        isLearning
          ? 'bg-accent/12 border border-accent/30'
          : 'hover:bg-ink/[0.03]'
      }`}
    >
      {/* Action label */}
      <span className="font-mono text-[9.5px] text-ink-soft flex-1 min-w-0 truncate">
        {action.label}
      </span>

      {/* Mapping display */}
      {isLearning ? (
        <span className="font-mono text-[9px] text-accent animate-pulse w-36 text-center">
          move a control…
        </span>
      ) : (
        <span
          className={`font-mono text-[9px] w-36 text-center tabular-nums ${
            mapping ? 'text-ink-soft' : 'text-muted/40'
          }`}
        >
          {formatMapping(mapping)}
        </span>
      )}

      {/* Learn button */}
      <button
        onClick={() => isLearning ? stopLearning() : startLearning(action.id)}
        className={`font-mono text-[8.5px] uppercase tracking-[0.12em] px-2 py-0.5 rounded border transition-colors ${
          isLearning
            ? 'border-accent/60 text-accent bg-accent/10 hover:bg-accent/20'
            : 'border-border/40 text-muted hover:text-ink hover:border-border/70'
        }`}
      >
        {isLearning ? 'cancel' : 'learn'}
      </button>

      {/* Clear button */}
      <button
        onClick={() => clearMapping(action.id)}
        disabled={!mapping}
        className="font-mono text-[8.5px] uppercase tracking-[0.12em] px-2 py-0.5 rounded border border-transparent text-muted/40 hover:border-red-500/30 hover:text-red-400 disabled:opacity-0 disabled:pointer-events-none transition-colors"
        title="Clear mapping"
      >
        ✕
      </button>
    </div>
  )
}

// ── Group section ─────────────────────────────────────────────────────────────

function ActionGroup({
  title,
  actions,
}: {
  title: string
  actions: MidiActionDef[]
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-muted/60 px-3 py-1 mt-2">
        {title}
      </p>
      {actions.map((a) => (
        <ActionRow key={a.id} action={a} />
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MidiSettings(): JSX.Element {
  const enabled           = useMidiStore((s) => s.enabled)
  const connectedDevices  = useMidiStore((s) => s.connectedDevices)
  const mappingCount      = useMidiStore((s) => Object.keys(s.mappings).length)
  const clearAllMappings  = useMidiStore((s) => s.clearAllMappings)
  const setEnabled        = useMidiStore((s) => s.setEnabled)

  // Actions split by deck
  const deckAActions = MIDI_ACTIONS.filter((a) => a.deck === 'A')
  const deckBActions = MIDI_ACTIONS.filter((a) => a.deck === 'B')
  const mixerActions = MIDI_ACTIONS.filter((a) => !a.deck)

  const groupActions = (actions: MidiActionDef[]) => {
    const groups: Record<string, MidiActionDef[]> = {}
    for (const a of actions) {
      ;(groups[a.group] ??= []).push(a)
    }
    return groups
  }

  return (
    <div className="space-y-4">
      {/* Header row: enable toggle + device list + clear-all */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Enable toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEnabled(!enabled)}
            className={`w-10 h-6 rounded-full transition-colors relative ${enabled ? 'bg-accent' : 'bg-border/60'}`}
          >
            <span
              className={`absolute top-1 w-4 h-4 rounded-full bg-paper shadow transition-all ${enabled ? 'left-5' : 'left-1'}`}
            />
          </button>
          <span className="font-mono text-[9.5px] text-ink-soft">
            {enabled ? 'MIDI enabled' : 'MIDI disabled'}
          </span>
        </div>

        {/* Connected devices */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {connectedDevices.length === 0 ? (
            <span className="font-mono text-[9px] text-muted/50">no MIDI devices detected</span>
          ) : (
            <>
              <span className="font-mono text-[9px] text-muted/60 shrink-0">
                {connectedDevices.length} device{connectedDevices.length !== 1 ? 's' : ''}:
              </span>
              <span className="font-mono text-[9px] text-ink-soft truncate">
                {connectedDevices.join(', ')}
              </span>
            </>
          )}
        </div>

        {/* Clear all */}
        {mappingCount > 0 && (
          <button
            onClick={() => {
              if (window.confirm(`Clear all ${mappingCount} MIDI mappings?`)) {
                clearAllMappings()
              }
            }}
            className="font-mono text-[8.5px] uppercase tracking-[0.12em] px-2 py-0.5 rounded border border-red-500/25 text-red-400/70 hover:border-red-500/50 hover:text-red-400 transition-colors"
          >
            clear all
          </button>
        )}
      </div>

      {/* Instructions */}
      <div className="flex items-start gap-2 font-mono text-[9.5px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
        <span className="shrink-0 text-accent">ℹ</span>
        <span>
          press <strong className="text-ink-soft">Learn</strong> next to an action,
          then move a knob, fader, or press a pad on your controller.
          press <kbd className="bg-ink/[0.07] border border-border/30 rounded px-1 text-ink-soft text-[8.5px]">Esc</kbd> to cancel.
          mappings persist across sessions.
        </span>
      </div>

      {/* Action table header */}
      <div className="flex items-center gap-3 px-3 font-mono text-[8px] uppercase tracking-[0.14em] text-muted/50 border-b border-border/20 pb-1">
        <span className="flex-1">Action</span>
        <span className="w-36 text-center">Mapping</span>
        <span className="w-12 text-center">Learn</span>
        <span className="w-8" />
      </div>

      {/* Deck A */}
      <div>
        <h3 className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-accent/80 px-3 pt-2 pb-1 border-b border-border/15">
          Deck A
        </h3>
        {Object.entries(groupActions(deckAActions)).map(([group, actions]) => (
          <ActionGroup
            key={group}
            title={GROUP_LABELS[group as MidiActionGroup] ?? group}
            actions={actions}
          />
        ))}
      </div>

      {/* Deck B */}
      <div>
        <h3 className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-accent/80 px-3 pt-2 pb-1 border-b border-border/15">
          Deck B
        </h3>
        {Object.entries(groupActions(deckBActions)).map(([group, actions]) => (
          <ActionGroup
            key={group}
            title={GROUP_LABELS[group as MidiActionGroup] ?? group}
            actions={actions}
          />
        ))}
      </div>

      {/* Mixer */}
      <div>
        <h3 className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-accent/80 px-3 pt-2 pb-1 border-b border-border/15">
          Mixer
        </h3>
        {Object.entries(groupActions(mixerActions)).map(([group, actions]) => (
          <ActionGroup
            key={group}
            title={GROUP_LABELS[group as MidiActionGroup] ?? group}
            actions={actions}
          />
        ))}
      </div>
    </div>
  )
}
