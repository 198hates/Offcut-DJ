import { describe, it, expect } from 'vitest'
import {
  sanitiseSegment, artistAlbumPath, resolveCollision, planConsolidation,
  UNKNOWN_ARTIST, UNKNOWN_ALBUM
} from '../track-destination'
import type { Track } from '../../../shared/types'

const track = (over: Partial<Track> = {}): Track =>
  ({
    id: 't1', filePath: '/src/song.mp3', title: 'Song', artist: 'Artist',
    album: 'Album', genre: '', year: null, label: '', bpm: null, key: null,
    durationSeconds: null, rating: 0, color: '', energy: null, danceability: null,
    mood: null, playCount: 0, lastPlayedAt: null, dateAdded: '', updatedAt: null,
    comment: '', tags: [], customTags: {}, cuePoints: [], beatgrid: [],
    analysedBeatgrid: null, gridSummary: { markers: 0, hasAnalysed: false, analysedSource: null, analysedMedianBpm: null, analysedConfidence: null },
    editLineage: null, sourceIds: {}, fileSize: null, fileType: null,
    sampleRate: null, bitDepth: null, gainDb: null, phrases: null,
    embedding: null, overviewPeaks: null, ...over
  }) as Track

const none = (): boolean => false

describe('sanitiseSegment', () => {
  it('replaces path separators and reserved characters', () => {
    expect(sanitiseSegment('AC/DC', 'x')).toBe('AC_DC')
    // ':' is the classic Mac separator — Finder renders a stored ':' as '/'
    expect(sanitiseSegment('Artist: The Remixes', 'x')).toBe('Artist_ The Remixes')
    expect(sanitiseSegment('a*b?c"d<e>f|g', 'x')).toBe('a_b_c_d_e_f_g')
  })

  it('falls back when the name is empty or becomes empty', () => {
    expect(sanitiseSegment('', UNKNOWN_ARTIST)).toBe(UNKNOWN_ARTIST)
    expect(sanitiseSegment('   ', UNKNOWN_ARTIST)).toBe(UNKNOWN_ARTIST)
    expect(sanitiseSegment('...', UNKNOWN_ALBUM)).toBe(UNKNOWN_ALBUM)
  })

  it('strips leading dots so it cannot create a hidden directory', () => {
    expect(sanitiseSegment('.38 Special', 'x')).toBe('38 Special')
  })

  it('trims trailing dots and spaces (invalid on Windows)', () => {
    expect(sanitiseSegment('Album Name. ', 'x')).toBe('Album Name')
  })

  it('collapses whitespace and caps absurd lengths', () => {
    expect(sanitiseSegment('A    B', 'x')).toBe('A B')
    expect(sanitiseSegment('z'.repeat(500), 'x')).toHaveLength(200)
  })
})

describe('artistAlbumPath', () => {
  it('builds Artist/Album/filename under the root', () => {
    const p = artistAlbumPath(track({ artist: 'Daft Punk', album: 'Discovery', filePath: '/x/One More Time.mp3' }), '/Music')
    expect(p).toBe('/Music/Daft Punk/Discovery/One More Time.mp3')
  })

  it('uses Apple Music-style fallbacks for missing metadata', () => {
    const p = artistAlbumPath(track({ artist: '', album: '', filePath: '/x/y.mp3' }), '/Music')
    expect(p).toBe(`/Music/${UNKNOWN_ARTIST}/${UNKNOWN_ALBUM}/y.mp3`)
  })

  it('keeps the original filename rather than rebuilding it', () => {
    const p = artistAlbumPath(track({ filePath: '/x/01 - weird  name!.aiff' }), '/M')
    expect(p.endsWith('/01 - weird  name!.aiff')).toBe(true)
  })
})

describe('resolveCollision', () => {
  it('returns the path untouched when nothing is in the way', () => {
    expect(resolveCollision('/M/A/B/s.mp3', none, new Set())).toBe('/M/A/B/s.mp3')
  })

  it('suffixes around an existing file', () => {
    const exists = (p: string): boolean => p === '/M/A/B/s.mp3'
    expect(resolveCollision('/M/A/B/s.mp3', exists, new Set())).toBe('/M/A/B/s (1).mp3')
  })

  it('suffixes around another move in the same batch', () => {
    expect(resolveCollision('/M/A/B/s.mp3', none, new Set(['/M/A/B/s.mp3']))).toBe('/M/A/B/s (1).mp3')
  })

  it('keeps counting past the first free-looking slot', () => {
    const exists = (p: string): boolean => p === '/M/s.mp3' || p === '/M/s (1).mp3'
    expect(resolveCollision('/M/s.mp3', exists, new Set(['/M/s (2).mp3']))).toBe('/M/s (3).mp3')
  })
})

describe('planConsolidation', () => {
  it('plans a move for a track outside the root', () => {
    const moves = planConsolidation(
      [track({ id: 'a', artist: 'X', album: 'Y', filePath: '/elsewhere/s.mp3' })], '/M', none
    )
    expect(moves).toEqual([{ from: '/elsewhere/s.mp3', to: '/M/X/Y/s.mp3', trackId: 'a' }])
  })

  it('skips a file already exactly where it belongs — re-running is a no-op', () => {
    const t = track({ artist: 'X', album: 'Y', filePath: '/M/X/Y/s.mp3' })
    expect(planConsolidation([t], '/M', none)).toEqual([])
  })

  it('still moves a file that is under the root but in the wrong place', () => {
    // Loose in the root, or filed under the wrong artist — both should be tidied.
    const t = track({ id: 'b', artist: 'X', album: 'Y', filePath: '/M/s.mp3' })
    expect(planConsolidation([t], '/M', none)).toEqual([
      { from: '/M/s.mp3', to: '/M/X/Y/s.mp3', trackId: 'b' }
    ])
  })

  it('does not plan two moves onto the same destination', () => {
    const moves = planConsolidation([
      track({ id: 'a', artist: 'X', album: 'Y', filePath: '/one/s.mp3' }),
      track({ id: 'b', artist: 'X', album: 'Y', filePath: '/two/s.mp3' })
    ], '/M', none)
    expect(moves[0].to).toBe('/M/X/Y/s.mp3')
    expect(moves[1].to).toBe('/M/X/Y/s (1).mp3')
    expect(new Set(moves.map((m) => m.to)).size).toBe(2)
  })

  it('ignores tracks with no file path', () => {
    expect(planConsolidation([track({ filePath: '' })], '/M', none)).toEqual([])
  })
})
