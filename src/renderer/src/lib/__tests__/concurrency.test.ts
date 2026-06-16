import { describe, it, expect } from 'vitest'
import { mapPool } from '../concurrency'

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
