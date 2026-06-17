// Mirrors the desktop Offcut palette (dark theme + always-dark deck zone) so the
// mobile app reads as the same product. Values lifted from the renderer CSS vars
// and the deck variables.

export const C = {
  // surfaces (deepest → lightest)
  bg: '#100D09', // deck-bg — app background
  panel: '#1A1612', // chassis — cards / panels
  deckPanel: '#060503', // deepest — waveform well
  paper: '#14110C', // input fields
  // ink
  ink: '#EBE5D3',
  inkSoft: '#B5AC97',
  muted: '#A39882',
  border: '#2A241C',
  // spot
  accent: '#D86A4A', // terracotta
  accentRgb: '216,106,74',
  rec: '#E5484D',
  // waveform earthen bands (overview / minimap)
  waveCream: '#ECE3CC',
  waveMid: '#C2683E',
  waveLow: '#6B5A3E'
} as const

// Three-band deck waveform colours (rgba strings), matching components/Waveform.tsx.
export const WAVE = {
  future: { low: 'rgba(248,232,195,0.98)', mid: 'rgba(215,118,28,0.94)', high: 'rgba(25,135,255,0.90)' },
  past: { low: 'rgba(130,115,85,0.42)', mid: 'rgba(100,52,12,0.40)', high: 'rgba(15,70,145,0.38)' },
  playheadGlow: 'rgba(255,255,255,0.07)',
  playheadMid: 'rgba(255,255,255,0.15)',
  playhead: 'rgba(255,255,255,0.97)',
  baseline: 'rgba(255,255,255,0.12)'
} as const

// The desktop's TRACK_COLORS (TrackDetail) and mood gradient stops.
export const TRACK_COLORS = [
  '#6E8059', '#4E7090', '#B07A4E', '#C9A02C',
  '#B86E72', '#874850', '#8E8473', '#B84A2B'
]
export const MOOD_GRADIENT = ['#2a1f3d', '#4a3860', '#6e6553', '#c8904a', '#f5c842']
export const MOOD_LABELS = ['Dark', 'Melancholic', 'Neutral', 'Uplifting', 'Euphoric']

// JetBrains Mono — the desktop is a monospace-forward UI.
export const MONO = 'JetBrainsMono_400Regular'
export const MONO_BOLD = 'JetBrainsMono_700Bold'

/** Energy cell fill — terracotta ramped by level, like the desktop. */
export function energyFill(n: number): string {
  return `rgba(${C.accentRgb},${0.4 + (n / 10) * 0.6})`
}
