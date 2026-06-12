import { describe, it, expect } from 'vitest'
import { parseAppleLibrary, dictToObject, type PlistDict } from '../reader'

// A realistic iTunes "Library.xml" head: the root dict interleaves integers,
// strings, a date and a boolean BEFORE the Tracks dict — exactly the mixed-type
// ordering that a tag-grouping parser scrambles.
const LIBRARY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Major Version</key><integer>1</integer>
  <key>Minor Version</key><integer>1</integer>
  <key>Date</key><date>2026-01-02T03:04:05Z</date>
  <key>Application Version</key><string>12.0</string>
  <key>Show Content Ratings</key><true/>
  <key>Music Folder</key><string>file://localhost/Users/dj/Music/</string>
  <key>Tracks</key>
  <dict>
    <key>456</key>
    <dict>
      <key>Track ID</key><integer>456</integer>
      <key>Name</key><string>Strobe</string>
      <key>Artist</key><string>deadmau5</string>
      <key>Total Time</key><integer>634000</integer>
      <key>Year</key><integer>2009</integer>
      <key>BPM</key><integer>128</integer>
      <key>Rating</key><integer>100</integer>
      <key>Album</key><string>For Lack of a Better Name</string>
      <key>Location</key><string>file://localhost/Users/dj/Music/Strobe.mp3</string>
    </dict>
    <key>789</key>
    <dict>
      <key>Track ID</key><integer>789</integer>
      <key>Name</key><string>Café Disco</string>
      <key>Artist</key><string>A &amp; B</string>
      <key>Location</key><string>file://localhost/Users/dj/Music/Cafe%20Disco.mp3</string>
    </dict>
  </dict>
  <key>Playlists</key>
  <array>
    <dict><key>Name</key><string>Favourites</string></dict>
  </array>
</dict>
</plist>`

describe('parseAppleLibrary — order-preserving plist', () => {
  it('locates the Tracks dict despite mixed-type root keys before it', () => {
    const root = parseAppleLibrary(LIBRARY)
    expect(root['Major Version']).toBe(1)
    expect(root['Application Version']).toBe('12.0')
    expect(root['Show Content Ratings']).toBe(true)
    expect(typeof root['Tracks']).toBe('object')
  })

  it('pairs every key with the value that follows it (no scrambling)', () => {
    const root = parseAppleLibrary(LIBRARY)
    const tracks = root['Tracks'] as PlistDict
    const t = tracks['456'] as PlistDict
    expect(t['Name']).toBe('Strobe')
    expect(t['Artist']).toBe('deadmau5')
    expect(t['Album']).toBe('For Lack of a Better Name')
    expect(t['Total Time']).toBe(634000)
    expect(t['Year']).toBe(2009)
    expect(t['BPM']).toBe(128)
    expect(t['Rating']).toBe(100)
    expect(t['Location']).toBe('file://localhost/Users/dj/Music/Strobe.mp3')
  })

  it('decodes XML entities in values', () => {
    const root = parseAppleLibrary(LIBRARY)
    const tracks = root['Tracks'] as PlistDict
    const t = tracks['789'] as PlistDict
    expect(t['Artist']).toBe('A & B')
    expect(t['Name']).toBe('Café Disco')
  })

  it('parses arrays', () => {
    const root = parseAppleLibrary(LIBRARY)
    const playlists = root['Playlists'] as PlistDict[]
    expect(Array.isArray(playlists)).toBe(true)
    expect(playlists[0]['Name']).toBe('Favourites')
  })
})

describe('dictToObject — value coercion', () => {
  it('coerces integers/reals to numbers and true/false to booleans', () => {
    const root = parseAppleLibrary(`<plist version="1.0"><dict>
      <key>n</key><integer>42</integer>
      <key>f</key><real>3.5</real>
      <key>yes</key><true/>
      <key>no</key><false/>
      <key>s</key><string>hi</string>
    </dict></plist>`)
    expect(root['n']).toBe(42)
    expect(root['f']).toBe(3.5)
    expect(root['yes']).toBe(true)
    expect(root['no']).toBe(false)
    expect(root['s']).toBe('hi')
  })

  it('is exported for direct use', () => {
    expect(typeof dictToObject).toBe('function')
  })
})
