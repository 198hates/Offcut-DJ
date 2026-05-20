/**
 * Rekordbox XML import (File > Export Library to rekordbox xml in Rekordbox).
 *
 * Direct master.db access (SQLCipher) is planned for Phase 2 — see db-reader.ts.
 * The XML path is the recommended safe approach: it does not require Rekordbox to be closed
 * and works with all versions of Rekordbox (5, 6, 7).
 */
import { readFileSync } from 'fs'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import type { Track, CuePoint, ImportResult } from '../../../shared/types'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

export function importFromIntegration(appDb: Database.Database, xmlPath: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  let parsed: Record<string, unknown>
  try {
    const xml = readFileSync(xmlPath, 'utf8')
    parsed = parser.parse(xml)
  } catch (err) {
    result.errors.push(`Cannot read Rekordbox XML: ${(err as Error).message}`)
    return result
  }

  const root = parsed['DJ_PLAYLISTS'] as Record<string, unknown> | undefined
  if (!root) {
    result.errors.push('Not a valid Rekordbox XML file (missing DJ_PLAYLISTS root)')
    return result
  }

  const collection = root['COLLECTION'] as Record<string, unknown> | undefined
  const trackNodes = collection ? (collection['TRACK'] ?? []) : []
  const trackArr = Array.isArray(trackNodes) ? trackNodes : [trackNodes]

  const rbIdToInternalId = new Map<string, string>()
  const insertTrack = appDb.transaction((track: Track) => insertOrUpdateTrack(appDb, track))

  for (const node of trackArr) {
    try {
      const t = node as Record<string, unknown>
      const rbId = String(t['@_TrackID'] ?? '')
      const id = randomUUID()
      rbIdToInternalId.set(rbId, id)

      const cueNodes = t['POSITION_MARK'] ?? []
      const cueArr = Array.isArray(cueNodes) ? cueNodes : [cueNodes]

      const track: Track = {
        id,
        filePath: decodeRbLocation(t['@_Location'] as string),
        title: String(t['@_Name'] ?? ''),
        artist: String(t['@_Artist'] ?? ''),
        album: String(t['@_Album'] ?? ''),
        genre: String(t['@_Genre'] ?? ''),
        bpm: t['@_AverageBpm'] ? Number(t['@_AverageBpm']) : null,
        key: String(t['@_Tonality'] ?? '') || null,
        durationSeconds: t['@_TotalTime'] ? Number(t['@_TotalTime']) : null,
        rating: rbXmlRatingToStars(t['@_Rating'] as number | undefined),
        dateAdded: String(t['@_DateAdded'] ?? new Date().toISOString()),
        comment: String(t['@_Comments'] ?? ''),
        tags: [],
        customTags: {},
        cuePoints: cueArr
          .filter((c) => c && typeof c === 'object')
          .map((c, i) => rbCueToPoint(c as Record<string, unknown>, i)),
        beatgrid: [],
          energy: null,
          danceability: null,
          color: '',
          playCount: 0,
          lastPlayedAt: null,
        sourceIds: { rekordbox: rbId }
      }

      insertTrack(track)
      result.tracksImported++
    } catch (err) {
      result.errors.push(`Track error: ${(err as Error).message}`)
    }
  }

  const playlistsRoot = root['PLAYLISTS'] as Record<string, unknown> | undefined
  if (playlistsRoot) {
    importPlaylistNode(appDb, playlistsRoot['NODE'] as Record<string, unknown>, null, rbIdToInternalId, result)
  }

  return result
}

function importPlaylistNode(
  db: Database.Database,
  node: Record<string, unknown> | undefined,
  parentId: string | null,
  trackMap: Map<string, string>,
  result: ImportResult
): void {
  if (!node) return
  const type = Number(node['@_Type'] ?? 0)
  const name = String(node['@_Name'] ?? '')

  if (name === 'ROOT') {
    const children = node['NODE'] ?? []
    const arr = Array.isArray(children) ? children : [children]
    arr.forEach((child) => importPlaylistNode(db, child as Record<string, unknown>, parentId, trackMap, result))
    return
  }

  const id = randomUUID()
  const isFolder = type === 0

  db.prepare(`
    INSERT OR REPLACE INTO playlists (id, name, is_folder, parent_id, sort_order, source_ids)
    VALUES (?, ?, ?, ?, 0, '{}')
  `).run(id, name, isFolder ? 1 : 0, parentId)

  if (!isFolder) {
    const entries = node['TRACK'] ?? []
    const entryArr = Array.isArray(entries) ? entries : [entries]
    entryArr.forEach((entry: unknown, order: number) => {
      const e = entry as Record<string, unknown>
      const rbId = String(e['@_Key'] ?? '')
      const trackId = trackMap.get(rbId)
      if (trackId) {
        db.prepare(
          'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
        ).run(id, trackId, order)
      }
    })
    result.playlistsImported++
  }

  const children = node['NODE'] ?? []
  const arr = Array.isArray(children) ? children : [children]
  arr.forEach((child) => importPlaylistNode(db, child as Record<string, unknown>, id, trackMap, result))
}

function decodeRbLocation(location: string): string {
  if (!location) return ''
  try {
    const decoded = decodeURIComponent(location)
    return decoded.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '')
  } catch {
    return location
  }
}

function rbCueToPoint(node: Record<string, unknown>, fallbackIndex: number): CuePoint {
  return {
    index: node['@_Num'] !== undefined ? Number(node['@_Num']) : fallbackIndex,
    type: Number(node['@_Type']) === 4 ? 'loop' : Number(node['@_Num']) >= 0 ? 'hotcue' : 'memory',
    positionMs: Math.round(Number(node['@_Start'] ?? 0) * 1000),
    color: rgbToHex(Number(node['@_Red'] ?? 255), Number(node['@_Green'] ?? 140), Number(node['@_Blue'] ?? 0)),
    label: String(node['@_Name'] ?? '')
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function rbXmlRatingToStars(rating: number | undefined): number {
  if (!rating) return 0
  const map: Record<number, number> = { 51: 1, 102: 2, 153: 3, 204: 4, 255: 5 }
  return map[rating] ?? 0
}
