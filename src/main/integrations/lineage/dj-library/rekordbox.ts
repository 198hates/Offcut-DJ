// Read a Rekordbox collection XML for owned-library dedup, and write saved finds
// back as an importable playlist. Rekordbox 6/7 keep the live library in an
// encrypted SQLite db, so the supported bridge is the XML export (File > Export
// Collection in xml format) for reading, and a minimal rekordbox.xml for writing.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import type { LibraryTrackRef } from '../types'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' })
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@', format: true })

/** A Rekordbox <TRACK> element with @-prefixed attributes. */
interface RekordboxTrackEl {
  '@Artist'?: string
  '@Name'?: string
  '@Album'?: string
  '@AverageBpm'?: string
  '@Tonality'?: string
  '@Rating'?: string
  '@DateAdded'?: string
  '@Location'?: string
}

export interface RekordboxLibraryTrack extends LibraryTrackRef {
  album: string
  bpm: number | null
  key: string | null
  rating: number
  dateAdded: string | null
  location: string | null
}

// Normalised shape the rest of the engine consumes.
function toLibraryTrack(t: RekordboxTrackEl): RekordboxLibraryTrack {
  return {
    artist: t['@Artist'] || '',
    title: t['@Name'] || '',
    album: t['@Album'] || '',
    bpm: t['@AverageBpm'] ? Number(t['@AverageBpm']) : null,
    key: t['@Tonality'] || null, // Rekordbox stores key here
    rating: t['@Rating'] ? Number(t['@Rating']) : 0,
    dateAdded: t['@DateAdded'] || null,
    location: t['@Location'] ? safeUrlToPath(t['@Location']) : null
  }
}

function safeUrlToPath(loc: string): string {
  try {
    return fileURLToPath(loc)
  } catch {
    return loc
  }
}

function pathToFileUrl(p: string): string {
  return 'file://localhost' + encodeURI(p.startsWith('/') ? p : '/' + p)
}

export function readRekordbox(xmlPath: string): { tracks: RekordboxLibraryTrack[] } {
  const xml = parser.parse(readFileSync(xmlPath, 'utf8')) as {
    DJ_PLAYLISTS?: { COLLECTION?: { TRACK?: RekordboxTrackEl | RekordboxTrackEl[] } }
  }
  const coll = xml.DJ_PLAYLISTS?.COLLECTION?.TRACK || []
  const tracks = (Array.isArray(coll) ? coll : [coll]).map(toLibraryTrack)
  return { tracks }
}

/** A find to write into the export playlist. */
export interface RekordboxFind {
  artist: string
  title: string
  location?: string
}

// Build a minimal rekordbox.xml Rekordbox can import as a playlist.
// finds: [{ artist, title, location? }] — a location lets Rekordbox match files
// already in your collection rather than treating them as new.
export function writeRekordboxPlaylist({
  finds,
  playlistName = 'Lineage',
  outPath
}: {
  finds: RekordboxFind[]
  playlistName?: string
  outPath: string
}): string {
  const tracks = finds.map((f, i) => ({
    '@TrackID': i + 1,
    '@Name': f.title,
    '@Artist': f.artist,
    ...(f.location ? { '@Location': pathToFileUrl(f.location) } : {})
  }))
  const doc = {
    DJ_PLAYLISTS: {
      '@Version': '1.0.0',
      PRODUCT: { '@Name': 'offcut', '@Version': '1.0', '@Company': '' },
      COLLECTION: { '@Entries': tracks.length, TRACK: tracks },
      PLAYLISTS: {
        NODE: {
          '@Type': '0',
          '@Name': 'ROOT',
          '@Count': 1,
          NODE: {
            '@Type': '1',
            '@Name': playlistName,
            '@Entries': tracks.length,
            TRACK: tracks.map((t) => ({ '@Key': t['@TrackID'] }))
          }
        }
      }
    }
  }
  writeFileSync(outPath, '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(doc))
  return outPath
}
