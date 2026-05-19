export type IntegrationId = 'rekordbox' | 'serato' | 'traktor' | 'apple-music'

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
  dateAdded: string
  comment: string
  tags: string[]
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  sourceIds: Partial<Record<IntegrationId, string>>
}

export interface Playlist {
  id: string
  name: string
  isFolder: boolean
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
