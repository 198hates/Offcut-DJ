import { readFileSync } from 'fs'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import type { Track, ImportResult } from '../../../shared/types'

const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'dict' || name === 'array'
})

export function importFromIntegration(db: Database.Database, xmlPath: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  let xml: string
  try {
    xml = readFileSync(xmlPath, 'utf8')
  } catch (err) {
    result.errors.push(`Cannot read file: ${(err as Error).message}`)
    return result
  }

  const parsed = parser.parse(xml) as Record<string, unknown>
  const plist = parsed['plist'] as Record<string, unknown> | undefined
  if (!plist) {
    result.errors.push('Not a valid iTunes/Apple Music XML file')
    return result
  }

  const rootDict = parsePlistDict(plist['dict'] as unknown[])
  const tracksDict = rootDict['Tracks'] as Record<string, unknown> | undefined
  if (!tracksDict) {
    result.errors.push('No Tracks dictionary found in library XML')
    return result
  }

  const insertTrack = db.transaction((track: Track) => insertOrUpdateTrack(db, track))

  for (const [appleMusicId, trackData] of Object.entries(tracksDict)) {
    try {
      const t = trackData as Record<string, unknown>
      const filePath = decodeAppleFileUrl(t['Location'] as string)
      if (!filePath) continue

      const track: Track = {
        id: randomUUID(),
        filePath,
        title: String(t['Name'] ?? ''),
        artist: String(t['Artist'] ?? ''),
        album: String(t['Album'] ?? ''),
        genre: String(t['Genre'] ?? ''),
        bpm: t['BPM'] ? Number(t['BPM']) : null,
        key: null,
        durationSeconds: t['Total Time'] ? Number(t['Total Time']) / 1000 : null,
        rating: t['Rating'] ? Math.round(Number(t['Rating']) / 20) : 0,
        dateAdded: t['Date Added'] ? String(t['Date Added']) : new Date().toISOString(),
        comment: String(t['Comments'] ?? ''),
        tags: [],
        customTags: {},
        cuePoints: [],
        beatgrid: [],
          energy: null,
          danceability: null,
          color: '',
          playCount: 0,
          lastPlayedAt: null,
        sourceIds: { 'apple-music': appleMusicId }
      }

      insertTrack(track)
      result.tracksImported++
    } catch (err) {
      result.errors.push(`Track error: ${(err as Error).message}`)
    }
  }

  return result
}

function parsePlistDict(dictArray: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!Array.isArray(dictArray) || dictArray.length === 0) return result

  const dict = dictArray[0] as Record<string, unknown>
  const keys = (dict['key'] as string[]) ?? []
  const values = Object.entries(dict)
    .filter(([k]) => k !== 'key')
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))

  keys.forEach((k, i) => {
    result[k] = values[i]
  })

  return result
}

function decodeAppleFileUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const decoded = decodeURIComponent(url)
    if (process.platform === 'darwin') {
      return decoded.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '')
    }
    return decoded.replace(/^file:\/\/\//, '').replace(/\//g, '\\')
  } catch {
    return null
  }
}
