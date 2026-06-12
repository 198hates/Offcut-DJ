import { describe, it, expect } from 'vitest'
import { splitTraktorPath, traktorKey, joinTraktorPath } from '../path'

// These tests run on darwin (posix branch).

describe('splitTraktorPath (boot volume)', () => {
  it('uses /: before each component and a trailing /:', () => {
    const loc = splitTraktorPath('/Users/dj/Music/song.mp3')
    expect(loc.volume).toBe('')
    expect(loc.dir).toBe('/:Users/:dj/:Music/:')
    expect(loc.file).toBe('song.mp3')
  })

  it('has no stray space (guards the original bug)', () => {
    const loc = splitTraktorPath('/Users/dj/song.mp3')
    expect(loc.dir).not.toContain(' ')
  })
})

describe('splitTraktorPath (external volume)', () => {
  it('extracts the volume name from /Volumes/<name>', () => {
    const loc = splitTraktorPath('/Volumes/USB STICK/sets/song.mp3')
    expect(loc.volume).toBe('USB STICK')
    expect(loc.dir).toBe('/:sets/:')
    expect(loc.file).toBe('song.mp3')
  })
})

describe('round-trip split → join', () => {
  for (const p of [
    '/Users/dj/Music/song.mp3',
    '/Users/dj/Music/My Track (Club Mix).mp3',
    '/Volumes/USB/a/b/c/track.flac',
    '/Volumes/Big Drive/song.wav',
  ]) {
    it(`recovers ${p}`, () => {
      const loc = splitTraktorPath(p)
      expect(joinTraktorPath(loc.volume, loc.dir, loc.file)).toBe(p)
    })
  }
})

describe('traktorKey', () => {
  it('is VOLUME + DIR + FILE and matches the reader key construction', () => {
    const loc = splitTraktorPath('/Volumes/USB/sets/song.mp3')
    expect(traktorKey(loc)).toBe('USB/:sets/:song.mp3')
    // Reader builds the same key from raw attributes:
    expect(`${loc.volume}${loc.dir}${loc.file}`).toBe(traktorKey(loc))
  })
})
