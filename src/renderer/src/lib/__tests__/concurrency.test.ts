import { describe, it, expect } from 'vitest'
import { mapPool, suggestConcurrency, resolveConcurrency } from '../concurrency'

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('mapPool', () => {
  it('processes every item and reports completion progress', async () => {
    const seen: number[] = []
    let lastDone = 0
    await mapPool([1, 2, 3, 4, 5], 2, async (n) => { await tick(); seen.push(n) }, {
      onProgress: (done) => { lastDone = done }
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(lastDone).toBe(5)
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await tick(2)
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // actually ran concurrently
  })

  it('stops scheduling new work once cancelled', async () => {
    let processed = 0
    let cancel = false
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 2, async () => {
      processed++
      if (processed >= 4) cancel = true
      await tick()
    }, { cancelled: () => cancel })
    expect(processed).toBeLessThan(20)
  })

  it('swallows per-item errors and keeps going', async () => {
    const ok: number[] = []
    await mapPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); ok.push(n) })
    expect(ok.sort()).toEqual([1, 3])
  })
})

describe('suggestConcurrency', () => {
  it('scales with cores but leaves headroom', () => {
    expect(suggestConcurrency(4, 16)).toBe(2)   // 4 - 2
    expect(suggestConcurrency(8, 16)).toBe(6)   // 8 - 2
    expect(suggestConcurrency(10, 32)).toBe(8)  // capped at 8
  })

  it('never drops below 2', () => {
    expect(suggestConcurrency(1, 16)).toBe(2)
    expect(suggestConcurrency(2, 16)).toBe(2)
  })

  it('pulls back on low-RAM machines', () => {
    expect(suggestConcurrency(8, 8)).toBe(3)  // 8GB cap
    expect(suggestConcurrency(8, 4)).toBe(2)  // 4GB floor
  })

  it('ignores RAM when unknown (0)', () => {
    expect(suggestConcurrency(8, 0)).toBe(6)
  })
})

describe('resolveConcurrency', () => {
  it('honours an explicit positive setting, capped at 16', () => {
    expect(resolveConcurrency(5)).toBe(5)
    expect(resolveConcurrency(99)).toBe(16)
  })

  it('falls back to auto for 0 / undefined', () => {
    // navigator may be undefined in the node test env → cores default to 4 → suggest 2
    expect(resolveConcurrency(0)).toBeGreaterThanOrEqual(2)
    expect(resolveConcurrency(undefined)).toBeGreaterThanOrEqual(2)
  })
})
