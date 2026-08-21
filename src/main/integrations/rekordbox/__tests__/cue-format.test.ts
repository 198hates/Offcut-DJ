import { describe, it, expect } from 'vitest'
import { rbTimestamp, newCueId } from '../cue-format'

describe('rbTimestamp', () => {
  it("matches rekordbox's stored format exactly", () => {
    // Real value observed in a live master.db: 2024-07-21 14:01:03.943 +00:00
    expect(rbTimestamp(new Date('2024-07-21T14:01:03.943Z'))).toBe('2024-07-21 14:01:03.943 +00:00')
  })

  it('keeps millisecond precision and the explicit UTC offset', () => {
    const s = rbTimestamp(new Date('2026-01-02T03:04:05.006Z'))
    expect(s).toBe('2026-01-02 03:04:05.006 +00:00')
    // NOT SQLite's datetime('now') shape, which omits both
    expect(s).not.toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('newCueId', () => {
  it('produces a 10-digit numeric string like rekordbox uses', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const id = newCueId(() => r)
      expect(id).toMatch(/^\d{10}$/)
    }
  })

  it('never starts with a zero', () => {
    expect(newCueId(() => 0).startsWith('0')).toBe(false)
  })

  it('is not constant across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCueId()))
    expect(ids.size).toBeGreaterThan(190)
  })
})
