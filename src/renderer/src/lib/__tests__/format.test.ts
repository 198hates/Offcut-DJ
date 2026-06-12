import { describe, it, expect } from 'vitest'
import { formatHoursMinutes, formatDuration, formatTime } from '../format'

describe('formatHoursMinutes', () => {
  // Regression: a 90-minute set used to render "90h 00m" because the code
  // computed minutes/seconds but labelled them hours/minutes.
  it('treats the input as seconds (90 min set → 1h 30m)', () => {
    expect(formatHoursMinutes(90 * 60)).toBe('1h 30m')
  })

  it('shows just minutes under an hour', () => {
    expect(formatHoursMinutes(45 * 60)).toBe('45m')
    expect(formatHoursMinutes(5 * 60 + 30)).toBe('5m')
  })

  it('pads minutes within the hour part', () => {
    expect(formatHoursMinutes(3600 + 60)).toBe('1h 01m') // 1h 1m
    expect(formatHoursMinutes(2 * 3600 + 9 * 60)).toBe('2h 09m')
  })

  it('exactly one hour', () => {
    expect(formatHoursMinutes(3600)).toBe('1h 00m')
  })

  it('returns a dash for null/invalid/negative', () => {
    expect(formatHoursMinutes(null)).toBe('—')
    expect(formatHoursMinutes(undefined)).toBe('—')
    expect(formatHoursMinutes(-10)).toBe('—')
    expect(formatHoursMinutes(NaN)).toBe('—')
  })
})

describe('formatDuration (regression guard)', () => {
  it('seconds → m:ss', () => {
    expect(formatDuration(187)).toBe('3:07')
    expect(formatDuration(5)).toBe('0:05')
  })
  it('dashes invalid input', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('formatTime (regression guard)', () => {
  it('seconds → m:ss.t', () => {
    expect(formatTime(67.3)).toBe('1:07.3')
  })
  it('falls back to 0:00.0', () => {
    expect(formatTime(null)).toBe('0:00.0')
  })
})
