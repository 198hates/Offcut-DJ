import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type WaveformStyle = 'gradient' | 'three-band' | 'rgb'

interface WaveformStore {
  style: WaveformStyle
  setStyle: (s: WaveformStyle) => void
}

export const useWaveformStore = create<WaveformStore>()(
  persist(
    (set) => ({
      style: 'three-band' as WaveformStyle,
      setStyle: (style) => set({ style })
    }),
    { name: 'crate-waveform-style' }
  )
)
