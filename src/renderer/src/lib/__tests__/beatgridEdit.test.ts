import { describe, it, expect } from 'vitest'
import { buildGridMarkers, gridForAnchor } from '../beatgridEdit'

const near = (a: number, b: number, eps = 0.001): boolean => Math.abs(a - b) < eps
const beatMs = (bpm: number): number => 60000 / bpm

describe('gridForAnchor', () => {
  it('lands a beat exactly on the anchor and flags it as a downbeat', () => {
    const bpm = 120
    const anchor = 5000 // not a clean multiple of the beat length
    const g = gridForAnchor(bpm, 20000, anchor)
    const onAnchor = g.find((m) => near(m.positionMs, anchor))
    expect(onAnchor).toBeTruthy()
    expect(onAnchor?.isDownbeat).toBe(true)
  })

  it('spaces beats uniformly at the beat length', () => {
    const g = gridForAnchor(120, 10000, 1000)
    for (let i = 1; i < g.length; i++) {
      expect(near(g[i].positionMs - g[i - 1].positionMs, beatMs(120))).toBe(true)
    }
  })
})

describe('buildGridMarkers', () => {
  it('with no re-anchor, equals the single-anchor grid', () => {
    const a = buildGridMarkers(126, 60000, 0, null)
    const b = gridForAnchor(126, 60000, 0)
    expect(a.map((m) => m.positionMs)).toEqual(b.map((m) => m.positionMs))
  })

  it('re-phases the tail to the second anchor (a beat lands on it)', () => {
    const bpm = 120
    // re-drop shifted by a third of a beat — what a uniform grid can't represent
    const seam = 30000 + beatMs(bpm) / 3
    const g = buildGridMarkers(bpm, 60000, 0, seam)
    // a beat sits exactly on the re-anchor
    expect(g.some((m) => near(m.positionMs, seam))).toBe(true)
    // head beats are all before the seam, tail beats all at/after it
    const head = g.filter((m) => m.positionMs < seam)
    const tail = g.filter((m) => m.positionMs >= seam)
    expect(head.length).toBeGreaterThan(0)
    expect(tail.length).toBeGreaterThan(0)
    // head stays on the original phase (multiples of the beat from 0)
    expect(near(head[head.length - 1].positionMs % beatMs(bpm), 0)).toBe(true)
  })

  it('introduces exactly one irregular interval at the seam', () => {
    const bpm = 120
    const seam = 30000 + 137 // arbitrary sub-beat offset
    const g = buildGridMarkers(bpm, 60000, 0, seam)
    let irregular = 0
    for (let i = 1; i < g.length; i++) {
      if (!near(g[i].positionMs - g[i - 1].positionMs, beatMs(bpm), 1)) irregular++
    }
    // one discontinuity where the phase jumps; everything else is uniform
    expect(irregular).toBeLessThanOrEqual(1)
  })
})
