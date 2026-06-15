/**
 * Apple Music / iTunes "Library.xml" import.
 *
 * The file is an Apple *property list* (plist). A plist <dict> is an ORDERED
 * sequence of <key>V</key> pairs where the value V is the element that
 * immediately follows the key — so parsing MUST preserve document order. A
 * naive parse that groups children by tag name (all <integer> together, all
 * <string> together, …) destroys that pairing the moment a dict mixes types,
 * which every real iTunes library does. We therefore parse with
 * `preserveOrder` and walk the children in order.
 */
import { readFileSync } from 'fs'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import type { Track, ImportResult } from '../../../shared/types'

export type PlistValue = string | number | boolean | PlistDict | PlistValue[]
export interface PlistDict {
  [key: string]: PlistValue
}

const parser = new XMLParser({
  ignoreAttributes: true,
  preserveOrder: true,
  parseTagValue: false // keep values as strings; we coerce per plist type
})

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The element name of a preserveOrder node (ignoring the ':@' attribute slot). */
function tagOf(node: any): string | undefined {
  return Object.keys(node).find((k) => k !== ':@' && k !== '#text')
}

/** Text content of a preserveOrder element's child array. */
function textOf(children: any): string {
  if (!Array.isArray(children)) return ''
  const t = children.find((c: any) => '#text' in c)
  return t ? String(t['#text']) : ''
}

function nodeToValue(tag: string, children: any): PlistValue {
  switch (tag) {
    case 'dict':
      return dictToObject(children)
    case 'array':
      return (Array.isArray(children) ? children : [])
        .map((child: any) => {
          const t = tagOf(child)
          return t ? nodeToValue(t, child[t]) : null
        })
        .filter((v): v is PlistValue => v !== null)
    case 'true':
      return true
    case 'false':
      return false
    case 'integer':
    case 'real':
      return Number(textOf(children))
    default: // string, date, data, …
      return textOf(children)
  }
}

/** Convert the ordered children of a <dict> into a plain object. */
export function dictToObject(children: any[]): PlistDict {
  const obj: PlistDict = {}
  if (!Array.isArray(children)) return obj
  let pendingKey: string | null = null
  for (const node of children) {
    const tag = tagOf(node)
    if (!tag) continue
    if (tag === 'key') {
      pendingKey = textOf(node['key'])
    } else if (pendingKey !== null) {
      obj[pendingKey] = nodeToValue(tag, node[tag])
      pendingKey = null
    }
  }
  return obj
}

/** Parse a plist XML string into its root dictionary. */
export function parseAppleLibrary(xml: string): PlistDict {
  const tree = parser.parse(xml) as any[]
  const plistNode = tree.find((n) => 'plist' in n)
  if (!plistNode) throw new Error('Not a valid plist (missing <plist> root)')
  const dictNode = (plistNode['plist'] as any[]).find((n) => 'dict' in n)
  if (!dictNode) throw new Error('plist has no root <dict>')
  return dictToObject(dictNode['dict'])
}

export function importFromIntegration(db: Database.Database, xmlPath: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  let xml: string
  try {
    xml = readFileSync(xmlPath, 'utf8')
  } catch (err) {
    result.errors.push(`Cannot read file: ${(err as Error).message}`)
    return result
  }

  let root: PlistDict
  try {
    root = parseAppleLibrary(xml)
  } catch (err) {
    result.errors.push(`Not a valid iTunes/Apple Music XML file: ${(err as Error).message}`)
    return result
  }

  const tracksDict = root['Tracks'] as PlistDict | undefined
  if (!tracksDict || typeof tracksDict !== 'object') {
    result.errors.push('No Tracks dictionary found in library XML')
    return result
  }

  const insertTrack = db.transaction((track: Track) => insertOrUpdateTrack(db, track))

  for (const [appleMusicId, trackData] of Object.entries(tracksDict)) {
    try {
      const t = trackData as PlistDict
      const filePath = decodeAppleFileUrl(t['Location'] as string | undefined)
      if (!filePath) continue

      const track: Track = {
        id: randomUUID(),
        filePath,
        title: String(t['Name'] ?? ''),
        artist: String(t['Artist'] ?? ''),
        album: String(t['Album'] ?? ''),
        genre: String(t['Genre'] ?? ''),
        year: t['Year'] != null ? Number(t['Year']) : null,
        label: '',
        bpm: t['BPM'] != null ? Number(t['BPM']) : null,
        key: null,
        durationSeconds: t['Total Time'] != null ? Number(t['Total Time']) / 1000 : null,
        rating: t['Rating'] != null ? Math.round(Number(t['Rating']) / 20) : 0,
        dateAdded: t['Date Added'] ? String(t['Date Added']) : new Date().toISOString(),
        comment: String(t['Comments'] ?? ''),
        tags: [],
        customTags: {},
        cuePoints: [],
        beatgrid: [],
        energy: null,
        danceability: null,
        mood: null,
        analysedBeatgrid: null,
        editLineage: null,
        color: '',
        playCount: 0,
        lastPlayedAt: null,
        updatedAt: null,
        fileSize: null,
        fileType: null,
        sampleRate: null,
        bitDepth: null,
        gainDb: null,
        phrases: null,
        embedding: null,
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
