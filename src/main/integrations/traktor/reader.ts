import { readFileSync } from 'fs'
import { XMLParser } from 'fast-xml-parser'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { insertOrUpdateTrack } from '../../library/db'
import type { Track, ImportResult, CuePoint } from '../../../shared/types'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

export function importFromIntegration(db: Database.Database, nmlPath: string): ImportResult {
  const result: ImportResult = { tracksImported: 0, playlistsImported: 0, errors: [] }

  let parsed: Record<string, unknown>
  try {
    const xml = readFileSync(nmlPath, 'utf8')
    parsed = parser.parse(xml)
  } catch (err) {
    result.errors.push(`Failed to read NML file: ${(err as Error).message}`)
    return result
  }

  const nml = parsed['NML'] as Record<string, unknown>
  if (!nml) {
    result.errors.push('Not a valid Traktor NML file')
    return result
  }

  const collectionEntries = ((nml['COLLECTION'] as Record<string, unknown>)?.['ENTRY'] ?? []) as unknown[]
  const entries = Array.isArray(collectionEntries) ? collectionEntries : [collectionEntries]

  const traktorIdToInternalId = new Map<string, string>()

  const insertTrack = db.transaction((track: Track) => {
    insertOrUpdateTrack(db, track)
  })

  for (const entry of entries) {
    try {
      const e = entry as Record<string, unknown>
      const loc = e['LOCATION'] as Record<string, string> | undefined
      if (!loc) continue

      const filePath = buildFilePath(loc)
      const id = randomUUID()
      const traktorKey = `${loc['@_VOLUME']}${loc['@_DIR']}${loc['@_FILE']}`
      traktorIdToInternalId.set(traktorKey, id)

      const info = (e['INFO'] as Record<string, unknown>) ?? {}
      const tempo = (e['TEMPO'] as Record<string, unknown>) ?? {}
      const musicalKey = (e['MUSICAL_KEY'] as Record<string, unknown>) ?? {}
      const cuePoints = parseCuePoints(e['CUE_V2'])

      const track: Track = {
        id,
        filePath,
        title: String(e['@_TITLE'] ?? ''),
        artist: String(e['@_ARTIST'] ?? ''),
        album: String(info['@_ALBUM'] ?? ''),
        genre: String(info['@_GENRE'] ?? ''),
        bpm: tempo['@_BPM'] ? Number(tempo['@_BPM']) : null,
        key: traktorKeyToName(musicalKey['@_VALUE'] as number | undefined),
        durationSeconds: info['@_PLAYTIME'] ? Number(info['@_PLAYTIME']) : null,
        rating: ratingFromTraktor(info['@_RANKING'] as number | undefined),
        dateAdded: String(info['@_IMPORT_DATE'] ?? new Date().toISOString()),
        comment: String(info['@_COMMENT'] ?? ''),
        tags: [],
        cuePoints,
        beatgrid: [],
          energy: null,
          danceability: null,
          color: '',
          playCount: 0,
          lastPlayedAt: null,
        sourceIds: { traktor: traktorKey }
      }

      insertTrack(track)
      result.tracksImported++
    } catch (err) {
      result.errors.push(`Track error: ${(err as Error).message}`)
    }
  }

  const playlistNode = nml['PLAYLISTS'] as Record<string, unknown> | undefined
  if (playlistNode) {
    importPlaylistNode(db, playlistNode, null, traktorIdToInternalId, result)
  }

  return result
}

function importPlaylistNode(
  db: Database.Database,
  node: Record<string, unknown>,
  parentId: string | null,
  trackMap: Map<string, string>,
  result: ImportResult
): void {
  const nodeEl = node['NODE'] as unknown
  const nodes = Array.isArray(nodeEl) ? nodeEl : nodeEl ? [nodeEl] : []

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Record<string, unknown>
    const type = n['@_TYPE'] as string
    const name = n['@_NAME'] as string
    if (name === '$ROOT') {
      importPlaylistNode(db, n, parentId, trackMap, result)
      continue
    }

    const id = randomUUID()
    const isFolder = type === 'FOLDER'

    db.prepare(`
      INSERT OR REPLACE INTO playlists (id, name, is_folder, parent_id, sort_order, source_ids)
      VALUES (?, ?, ?, ?, ?, '{}')
    `).run(id, name, isFolder ? 1 : 0, parentId, i)

    if (!isFolder) {
      const entries = (n['PLAYLIST'] as Record<string, unknown>)?.['ENTRY']
      const entryArr = Array.isArray(entries) ? entries : entries ? [entries] : []
      entryArr.forEach((entry: unknown, order: number) => {
        const e = entry as Record<string, unknown>
        const primaryKey = (e['PRIMARYKEY'] as Record<string, unknown>) ?? {}
        const traktorKey = primaryKey['@_KEY'] as string
        const trackId = traktorKey ? trackMap.get(traktorKey) : undefined
        if (trackId) {
          db.prepare(
            'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES (?, ?, ?)'
          ).run(id, trackId, order)
        }
      })
      result.playlistsImported++
    }

    if (isFolder) {
      importPlaylistNode(db, n, id, trackMap, result)
    }
  }
}

function buildFilePath(loc: Record<string, string>): string {
  const dir = (loc['@_DIR'] ?? '').replace(/\//g, '/').replace(/^\//, '')
  const file = loc['@_FILE'] ?? ''
  const volume = loc['@_VOLUME'] ?? ''
  if (process.platform === 'darwin') {
    return `/${volume}/${dir}${file}`.replace(/\/+/g, '/')
  }
  return `${volume}\\${dir.replace(/\//g, '\\')}${file}`
}

function parseCuePoints(raw: unknown): CuePoint[] {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.map((c: unknown) => {
    const cue = c as Record<string, unknown>
    return {
      index: Number(cue['@_HOTCUE'] ?? -1),
      type: cue['@_TYPE'] === '4' ? 'loop' : cue['@_HOTCUE'] !== undefined ? 'hotcue' : 'memory',
      positionMs: Math.round((Number(cue['@_START']) / 1000)),
      color: String(cue['@_COLOR'] ?? '#ff8c00'),
      label: String(cue['@_NAME'] ?? '')
    }
  })
}

function traktorKeyToName(value: number | undefined): string | null {
  if (value === undefined) return null
  const keys = [
    '1d','8d','3d','10d','5d','12d','7d','2d','9d','4d','11d','6d',
    '1m','8m','3m','10m','5m','12m','7m','2m','9m','4m','11m','6m'
  ]
  return keys[value] ?? null
}

function ratingFromTraktor(ranking: number | undefined): number {
  if (!ranking) return 0
  return Math.round((ranking / 255) * 5)
}
