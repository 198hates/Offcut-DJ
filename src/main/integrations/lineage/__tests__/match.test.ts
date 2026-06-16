import { describe, it, expect } from 'vitest'
import { tokenize, coverage, looksLikeMatch } from '../match'

describe('tokenize', () => {
  it('lowercases, strips parentheticals and punctuation, drops single chars', () => {
    expect(tokenize('Floating Points - Silhouettes (Club Remix)')).toEqual([
      'floating',
      'points',
      'silhouettes'
    ])
    expect(tokenize('R.E.M.')).toEqual([]) // all single-char tokens dropped
  })
})

describe('coverage', () => {
  it('is 1 when every wanted token is present', () => {
    expect(coverage(['floating', 'points'], ['floating', 'points', 'extra'])).toBe(1)
  })
  it('is fractional for partial overlap', () => {
    expect(coverage(['david', 'bowie'], ['david', 'demarco'])).toBe(0.5)
  })
  it('treats an empty wanted set as fully covered', () => {
    expect(coverage([], ['anything'])).toBe(1)
  })
  it('matches by prefix only for longer tokens', () => {
    expect(coverage(['silhouettes'], ['silhouette'])).toBe(1) // prefix, len>=4
    expect(coverage(['to'], ['tomorrow'])).toBe(0) // short token needs exact
  })
})

describe('looksLikeMatch', () => {
  it('accepts the right track even with a remix suffix on the hit', () => {
    expect(
      looksLikeMatch(
        { artist: 'Floating Points', title: 'Silhouettes' },
        'Floating Points',
        'Silhouettes (Club Remix)'
      )
    ).toBe(true)
  })

  it('rejects a same-first-word different artist (the old bug)', () => {
    // Old first-word matcher passed this: "david" matched, and a coincidental
    // title-first-word would slip through. Now both fields must largely line up.
    expect(
      looksLikeMatch(
        { artist: 'David Bowie', title: 'Rebel Rebel' },
        'David DeMarco',
        'Rebel Yell'
      )
    ).toBe(false)
  })

  it('rejects a completely different track', () => {
    expect(
      looksLikeMatch(
        { artist: 'Aphex Twin', title: 'Windowlicker' },
        'Daft Punk',
        'Around the World'
      )
    ).toBe(false)
  })

  it('matches when the catalogue adds a featured artist', () => {
    expect(
      looksLikeMatch(
        { artist: 'Disclosure', title: 'Latch' },
        'Disclosure feat. Sam Smith',
        'Latch'
      )
    ).toBe(true)
  })

  it('does not match on artist alone when the title is wrong', () => {
    expect(
      looksLikeMatch(
        { artist: 'Bicep', title: 'Glue' },
        'Bicep',
        'Apricots'
      )
    ).toBe(false)
  })
})
