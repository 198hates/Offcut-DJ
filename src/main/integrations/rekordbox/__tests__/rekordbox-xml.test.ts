import { describe, it, expect } from 'vitest'
import { buildRekordboxXml, type RbPlaylist } from '../writer'
import type { Track } from '../../../../shared/types'

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id, filePath: `/Users/dj/Music/${id}.mp3`, title: id, artist: 'A', album: '',
    genre: '', year: null, label: '', bpm: 128, key: null, durationSeconds: 200,
    rating: 0, dateAdded: '2026-01-01T00:00:00Z', comment: '', tags: [], customTags: {},
    cuePoints: [], beatgrid: [], energy: null, danceability: null, mood: null,
    analysedBeatgrid: null, editLineage: null, color: '', playCount: 0,
    lastPlayedAt: null, updatedAt: null, fileSize: null, fileType: null,
    sampleRate: null, bitDepth: null, gainDb: null, phrases: null, embedding: null, sourceIds: {},
    ...over,
  } as Track
}

/** Pull all TrackID values from COLLECTION and all Key values from PLAYLISTS. */
function ids(xml: string): { trackIds: Set<string>; playlistKeys: string[] } {
  const trackIds = new Set<string>()
  for (const m of xml.matchAll(/<TRACK TrackID="([^"]*)"/g)) trackIds.add(m[1])
  const playlistKeys: string[] = []
  for (const m of xml.matchAll(/<TRACK Key="([^"]*)"\/>/g)) playlistKeys.push(m[1])
  return { trackIds, playlistKeys }
}

describe('buildRekordboxXml — TrackID/Key consistency', () => {
  it('every playlist Key resolves to a COLLECTION TrackID (no rekordbox ids)', () => {
    const tracks = [track('aaaa'), track('bbbb'), track('cccc')]
    const playlists: RbPlaylist[] = [
      { name: 'Set 1', isFolder: false, trackIds: ['cccc', 'aaaa'] },
    ]
    const xml = buildRekordboxXml(tracks, playlists)
    const { trackIds, playlistKeys } = ids(xml)
    expect(playlistKeys.length).toBe(2)
    for (const key of playlistKeys) expect(trackIds.has(key)).toBe(true)
  })

  it('uses the real rekordbox id when present, consistently in both places', () => {
    const tracks = [
      track('aaaa', { sourceIds: { rekordbox: '101' } }),
      track('bbbb', { sourceIds: { rekordbox: '202' } }),
    ]
    const playlists: RbPlaylist[] = [{ name: 'P', isFolder: false, trackIds: ['bbbb'] }]
    const xml = buildRekordboxXml(tracks, playlists)
    const { trackIds, playlistKeys } = ids(xml)
    expect(trackIds.has('101')).toBe(true)
    expect(trackIds.has('202')).toBe(true)
    expect(playlistKeys).toEqual(['202'])
  })

  it('mixed: some tracks have rekordbox ids, some do not, all still resolve', () => {
    const tracks = [
      track('aaaa', { sourceIds: { rekordbox: '500' } }),
      track('bbbb'), // no rb id → index-based
    ]
    const playlists: RbPlaylist[] = [
      { name: 'P', isFolder: false, trackIds: ['aaaa', 'bbbb'] },
    ]
    const xml = buildRekordboxXml(tracks, playlists)
    const { trackIds, playlistKeys } = ids(xml)
    for (const key of playlistKeys) expect(trackIds.has(key)).toBe(true)
    expect(playlistKeys.length).toBe(2)
  })

  it('Entries count matches the resolved key count', () => {
    const tracks = [track('aaaa')]
    const playlists: RbPlaylist[] = [
      { name: 'P', isFolder: false, trackIds: ['aaaa', 'missing'] }, // 'missing' isn't in collection
    ]
    const xml = buildRekordboxXml(tracks, playlists)
    expect(xml).toContain('Entries="1"') // only the resolvable track is counted
  })
})

describe('buildRekordboxXml — escaping & kind', () => {
  it('escapes XML metacharacters in names', () => {
    const tracks = [track('aaaa', { title: 'Rock & <Roll>', artist: 'A "B"' })]
    const xml = buildRekordboxXml(tracks, [])
    expect(xml).toContain('Name="Rock &amp; &lt;Roll&gt;"')
    expect(xml).toContain('Artist="A &quot;B&quot;"')
  })

  it('maps Kind by file extension', () => {
    const xml = buildRekordboxXml(
      [
        track('a', { filePath: '/m/a.flac' }),
        track('b', { filePath: '/m/b.wav' }),
        track('c', { filePath: '/m/c.aiff' }),
      ],
      []
    )
    expect(xml).toContain('Kind="FLAC File"')
    expect(xml).toContain('Kind="WAV File"')
    expect(xml).toContain('Kind="AIFF File"')
  })
})
