/**
 * Mixer store — lifts channel volume + crossfader out of Mixer.tsx local state
 * so the MIDI engine can write to it from outside the component tree.
 */
import { create } from 'zustand'

interface MixerState {
  volA: number
  volB: number
  xfade: number
}

interface MixerActions {
  setVolA:  (v: number) => void
  setVolB:  (v: number) => void
  setXfade: (v: number) => void
}

export const useMixerStore = create<MixerState & MixerActions>((set) => ({
  volA:     0.8,
  volB:     0.8,
  xfade:    0.5,
  setVolA:  (v) => set({ volA:  Math.max(0, Math.min(1, v)) }),
  setVolB:  (v) => set({ volB:  Math.max(0, Math.min(1, v)) }),
  setXfade: (v) => set({ xfade: Math.max(0, Math.min(1, v)) }),
}))
