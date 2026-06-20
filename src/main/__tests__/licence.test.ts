import { describe, it, expect } from 'vitest'
import { isValidLicenceKey, mintLicenceKey } from '../licence'

describe('licence keys', () => {
  it('accepts a freshly minted key', () => {
    expect(isValidLicenceKey(mintLicenceKey('NATHAN01'))).toBe(true)
  })

  it('is whitespace- and case-insensitive', () => {
    const k = mintLicenceKey('ABCD')
    expect(isValidLicenceKey(`  ${k.toLowerCase()} `)).toBe(true)
  })

  it('rejects a tampered check group', () => {
    const k = mintLicenceKey('ZZZZ')
    const last = k.slice(-1)
    const bad = k.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    expect(isValidLicenceKey(bad)).toBe(false)
  })

  it('rejects malformed keys', () => {
    expect(isValidLicenceKey('')).toBe(false)
    expect(isValidLicenceKey('GARBAGE')).toBe(false)
    expect(isValidLicenceKey('OFFCUT-XXXX')).toBe(false)
    expect(isValidLicenceKey('OFFCUT-XXX-XXXX-XXXX-XXXX')).toBe(false)
  })
})
