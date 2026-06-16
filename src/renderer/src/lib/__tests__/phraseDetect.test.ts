import { describe, it, expect } from 'vitest'
import { detectPhrasesFromMono } from '../phraseDetect'

const FS = 44100

/**
 * Build a mono signal from sections. Each section: { secs, bass, high } where
 * bass = 60 Hz amplitude (kick/bass), high = 2 kHz amplitude (treble/build).
 * A "drop" = loud bass + loud high; a "build" = rising high, no bass; quiet =
 * intro/breakdown/outro.
 */
function build(sections: { secs: number; bass: number; high: number }[]): Float32Array {
  const total = sections.reduce((n, s) => n + Math.round(s.secs * FS), 0)
  const out = new Float32Array(total)
  let o = 0
  for (const s of sections) {
    const n = Math.round(s.secs * FS)
    for (let i = 0; i < n; i++) {
      out[o++] = s.bass * Math.sin((2 * Math.PI * 60 * i) / FS) + s.high * Math.sin((2 * Math.PI * 2000 * i) / FS)
    }
  }
  return out
}

describe('detectPhrasesFromMono', () => {
  it('labels a classic intro → build → drop → breakdown → drop → outro shape', () => {
    const sig = build([
      { secs: 16, bass: 0.05, high: 0.05 }, // intro (quiet)
      { secs: 8,  bass: 0.02, high: 0.5 },  // build (rising treble, no bass)
      { secs: 24, bass: 0.8,  high: 0.6 },  // drop (loud, full)
      { secs: 16, bass: 0.03, high: 0.08 }, // breakdown (quiet)
      { secs: 24, bass: 0.8,  high: 0.6 },  // drop
      { secs: 16, bass: 0.05, high: 0.05 }, // outro (quiet)
    ])
    const segs = detectPhrasesFromMono(sig, FS, 128, 0)
    const labels = segs.map((s) => s.label)

    expect(segs.length).toBeGreaterThanOrEqual(4)
    expect(labels[0]).toBe('intro')
    expect(labels[labels.length - 1]).toBe('outro')
    expect(labels).toContain('drop')
    expect(labels).toContain('breakdown')
    // segments are ordered and non-overlapping
    for (let i = 1; i < segs.length; i++) expect(segs[i].startMs).toBe(segs[i - 1].endMs)
  })

  it('returns empty for too-short input', () => {
    expect(detectPhrasesFromMono(new Float32Array(FS), FS)).toEqual([])
  })

  it('handles a flat signal without throwing', () => {
    const flat = build([{ secs: 40, bass: 0.2, high: 0.2 }])
    const segs = detectPhrasesFromMono(flat, FS)
    expect(Array.isArray(segs)).toBe(true)
  })
})
