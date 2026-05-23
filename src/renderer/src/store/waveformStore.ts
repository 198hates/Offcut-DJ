import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type WaveformStyle = 'gradient' | 'three-band' | 'rgb'
export type KeyNotation = 'camelot' | 'openkey' | 'standard'

// ── Key notation display helpers ──────────────────────────────────────────────

const STANDARD_KEYS: Record<string, string> = {
  '1A': 'Am',  '1B': 'C',
  '2A': 'Em',  '2B': 'G',
  '3A': 'Bm',  '3B': 'D',
  '4A': 'F#m', '4B': 'A',
  '5A': 'C#m', '5B': 'E',
  '6A': 'G#m', '6B': 'B',
  '7A': 'D#m', '7B': 'F#',
  '8A': 'Bbm', '8B': 'Db',
  '9A': 'Fm',  '9B': 'Ab',
  '10A': 'Cm', '10B': 'Eb',
  '11A': 'Gm', '11B': 'Bb',
  '12A': 'Dm', '12B': 'F',
}

/**
 * Format a Camelot key string (e.g. "8A", "11B") into the
 * requested notation.
 *   camelot  → "8A"
 *   openkey  → "8m" / "8d"  (m=minor/mol, d=major/dur)
 *   standard → "Bbm" / "Db"
 */
export function displayKey(
  camelotKey: string | null | undefined,
  notation: KeyNotation
): string | null {
  if (!camelotKey) return null
  if (notation === 'camelot') return camelotKey

  const m = camelotKey.match(/^(\d{1,2})([AB])$/i)
  if (!m) return camelotKey

  const num  = m[1]
  const band = m[2].toUpperCase() as 'A' | 'B'
  const key  = `${num}${band}`

  if (notation === 'openkey') {
    return `${num}${band === 'A' ? 'm' : 'd'}`
  }

  // standard
  return STANDARD_KEYS[key] ?? camelotKey
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface WaveformStore {
  style: WaveformStyle
  keyNotation: KeyNotation
  autoGainEnabled: boolean
  setStyle: (s: WaveformStyle) => void
  setKeyNotation: (n: KeyNotation) => void
  setAutoGainEnabled: (v: boolean) => void
}

export const useWaveformStore = create<WaveformStore>()(
  persist(
    (set) => ({
      style:            'three-band' as WaveformStyle,
      keyNotation:      'camelot'    as KeyNotation,
      autoGainEnabled:  false,
      setStyle:            (style)           => set({ style }),
      setKeyNotation:      (keyNotation)     => set({ keyNotation }),
      setAutoGainEnabled:  (autoGainEnabled) => set({ autoGainEnabled }),
    }),
    { name: 'crate-waveform-style' }
  )
)
