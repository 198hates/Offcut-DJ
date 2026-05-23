/**
 * MIDI mapping store.
 *
 * Persisted to localStorage so mappings survive app restarts.
 * The MIDI engine reads this store to dispatch incoming messages.
 * Learn mode: set `learningActionId` → the engine captures the next
 * incoming MIDI message and calls `setMapping`.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ── Action catalogue ──────────────────────────────────────────────────────────

export type MidiActionGroup = 'transport' | 'hotcues' | 'loops' | 'channel' | 'mixer'
export type MidiControlType = 'button' | 'fader' | 'knob'
export type MidiDeck = 'A' | 'B'

export interface MidiActionDef {
  id: string
  label: string
  group: MidiActionGroup
  deck?: MidiDeck
  controlType: MidiControlType
}

function deckActions(deck: MidiDeck): MidiActionDef[] {
  const d = deck
  return [
    // Transport
    { id: `deck-${d}-play`,         label: 'Play / Pause',  group: 'transport', deck: d, controlType: 'button' },
    { id: `deck-${d}-cue`,          label: 'Cue',           group: 'transport', deck: d, controlType: 'button' },
    // Hot cues
    { id: `deck-${d}-hotcue-0`,     label: 'Hot Cue A',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-1`,     label: 'Hot Cue B',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-2`,     label: 'Hot Cue C',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-3`,     label: 'Hot Cue D',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-4`,     label: 'Hot Cue E',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-5`,     label: 'Hot Cue F',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-6`,     label: 'Hot Cue G',     group: 'hotcues',   deck: d, controlType: 'button' },
    { id: `deck-${d}-hotcue-7`,     label: 'Hot Cue H',     group: 'hotcues',   deck: d, controlType: 'button' },
    // Loops
    { id: `deck-${d}-loop-in`,      label: 'Loop In',       group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-loop-out`,     label: 'Loop Out',      group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-loop-toggle`,  label: 'Loop Toggle',   group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-beatloop-1`,   label: 'Beat Loop 1',   group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-beatloop-2`,   label: 'Beat Loop 2',   group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-beatloop-4`,   label: 'Beat Loop 4',   group: 'loops',     deck: d, controlType: 'button' },
    { id: `deck-${d}-beatloop-8`,   label: 'Beat Loop 8',   group: 'loops',     deck: d, controlType: 'button' },
    // Channel strip
    { id: `deck-${d}-volume`,       label: 'Volume',        group: 'channel',   deck: d, controlType: 'fader'  },
    { id: `deck-${d}-eq-high`,      label: 'EQ High',       group: 'channel',   deck: d, controlType: 'knob'   },
    { id: `deck-${d}-eq-mid`,       label: 'EQ Mid',        group: 'channel',   deck: d, controlType: 'knob'   },
    { id: `deck-${d}-eq-low`,       label: 'EQ Low',        group: 'channel',   deck: d, controlType: 'knob'   },
    { id: `deck-${d}-pitch`,        label: 'Pitch / Tempo', group: 'channel',   deck: d, controlType: 'fader'  },
  ]
}

export const MIDI_ACTIONS: MidiActionDef[] = [
  ...deckActions('A'),
  ...deckActions('B'),
  // Mixer
  { id: 'mixer-xfade', label: 'Crossfader', group: 'mixer', controlType: 'fader' },
]

// ── Mapping / store types ─────────────────────────────────────────────────────

export type MidiMessageType = 'note' | 'cc' | 'pitchbend'

export interface MidiMapping {
  /** MIDI channel 0–15 */
  channel: number
  messageType: MidiMessageType
  /** Note or CC number (0–127); ignored for pitchbend */
  number: number
  /** Device input name — informational only */
  deviceName?: string
}

interface MidiStoreState {
  enabled: boolean
  /** actionId → mapping */
  mappings: Record<string, MidiMapping>
  /** actionId currently being learned; null when idle */
  learningActionId: string | null
  /** Names of currently connected MIDI inputs */
  connectedDevices: string[]
}

interface MidiStoreActions {
  setEnabled:           (v: boolean) => void
  setMapping:           (actionId: string, m: MidiMapping) => void
  clearMapping:         (actionId: string) => void
  clearAllMappings:     () => void
  startLearning:        (actionId: string) => void
  stopLearning:         () => void
  setConnectedDevices:  (names: string[]) => void
}

export const useMidiStore = create<MidiStoreState & MidiStoreActions>()(
  persist(
    (set) => ({
      // ── State ───────────────────────────────────────────────────────────────
      enabled:             true,
      mappings:            {},
      learningActionId:    null,
      connectedDevices:    [],

      // ── Actions ─────────────────────────────────────────────────────────────
      setEnabled:          (v)  => set({ enabled: v }),
      setMapping:          (id, m) => set((s) => ({ mappings: { ...s.mappings, [id]: m } })),
      clearMapping:        (id) => set((s) => {
        const next = { ...s.mappings }
        delete next[id]
        return { mappings: next }
      }),
      clearAllMappings:    () => set({ mappings: {} }),
      startLearning:       (id) => set({ learningActionId: id }),
      stopLearning:        () => set({ learningActionId: null }),
      setConnectedDevices: (names) => set({ connectedDevices: names }),
    }),
    {
      name: 'od01-midi-mappings',
      // Only persist enabled + mappings; runtime state is transient
      partialize: (s) => ({ enabled: s.enabled, mappings: s.mappings }),
    }
  )
)
