export type IntegrationId = 'rekordbox' | 'serato' | 'traktor' | 'apple-music' | 'engine-dj' | 'm3u'

export interface CuePoint {
  index: number
  type: 'hotcue' | 'memory' | 'loop'
  positionMs: number
  color: string
  label: string
}

export interface BeatgridMarker {
  positionMs: number
  bpm: number
  isDownbeat?: boolean   // true = bar start (downbeat)
  confidence?: number    // model activation 0–1
}

export interface Track {
  id: string
  filePath: string
  title: string
  artist: string
  album: string
  genre: string
  bpm: number | null
  key: string | null
  durationSeconds: number | null
  rating: number
  color: string           // hex colour tag, '' = none
  energy: number | null        // 1–10, null = unset
  danceability: number | null  // 0–1, null = unset
  playCount: number
  lastPlayedAt: string | null
  dateAdded: string
  comment: string
  tags: string[]
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  sourceIds: Partial<Record<IntegrationId, string>>
}

export type SmartRuleField = 'bpm' | 'key' | 'genre' | 'artist' | 'album' | 'rating' | 'title' | 'comment' | 'durationSeconds' | 'dateAdded' | 'playCount' | 'lastPlayedAt' | 'energy' | 'tags'
export type SmartRuleOp = 'is' | 'is_not' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'between' | 'in_last_days'

export interface SmartRule {
  field: SmartRuleField
  op: SmartRuleOp
  value: string | number | [number, number]
}

export interface Playlist {
  id: string
  name: string
  color: string   // hex colour for blip dot (e.g. '#3CA8A1')
  isFolder: boolean
  isSmart: boolean
  isAutoGroup: boolean
  rules: SmartRule[]
  parentId: string | null
  sortOrder: number
  trackIds: string[]
  sourceIds: Partial<Record<IntegrationId, string>>
}

export interface LibraryStats {
  trackCount: number
  playlistCount: number
}

export interface ImportResult {
  tracksImported: number
  playlistsImported: number
  errors: string[]
}

export interface ExportResult {
  tracksExported: number
  playlistsExported: number
  errors: string[]
  cancelled: boolean
}

export interface AppSettings {
  rekordboxXmlPath: string
  rekordboxDbPath: string
  traktorCollectionPath: string
  seratoDir: string
  appleMusicXmlPath: string
  engineDjDbPath: string
  m3uExportDir: string
  theme: 'dark' | 'light' | 'system'
  defaultExportDir: string
  showWelcomeOnStartup: boolean
  lastImportedAt: string | null
  windowBounds: { x: number; y: number; width: number; height: number } | null
}
