// Wire types for the desktop phone-sync API.
//
// Deliberately a STANDALONE copy of the over-the-wire subset of the desktop's
// `src/shared/types.ts` — see /MOBILE_COMPANION_PLAN.md §7. We don't import the
// desktop types across the RN/Metro boundary (they pull in Electron-only types).
// These shapes are stable; keep them in sync with src/shared/types.ts by hand.

export interface CuePoint {
  index: number
  type: 'hotcue' | 'memory' | 'loop'
  positionMs: number
  endMs?: number
  color: string
  label: string
  confidence?: number
}

export interface BeatgridMarker {
  positionMs: number
  bpm: number
  isDownbeat?: boolean
  confidence?: number
}

export interface Beat {
  positionMs: number
  beatInBar: number
  confidence: number
}

export interface Bar {
  positionMs: number
  bpm: number
  barIndex: number
}

export interface Beatgrid {
  beats: Beat[]
  bars: Bar[]
  downbeats: number[]
  source: string
  medianBpm: number
  firstBeatMs: number
  isConstantTempo: boolean
  computedAt: string
}

export interface PhraseSegment {
  label: string
  startMs: number
  endMs: number
  confidence: number
}

export interface Track {
  id: string
  filePath: string
  title: string
  artist: string
  album: string
  genre: string
  year: number | null
  label: string
  bpm: number | null
  key: string | null
  durationSeconds: number | null
  rating: number
  color: string
  energy: number | null
  danceability: number | null
  mood: number | null
  playCount: number
  lastPlayedAt: string | null
  dateAdded: string
  updatedAt: string | null
  comment: string
  tags: string[]
  customTags: Record<string, string>
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  analysedBeatgrid: Beatgrid | null
  editLineage: unknown
  sourceIds: Record<string, string>
  fileSize: number | null
  fileType: string | null
  sampleRate: number | null
  bitDepth: number | null
  gainDb: number | null
  phrases: PhraseSegment[] | null
}

export interface Playlist {
  id: string
  name: string
  color: string
  isFolder: boolean
  isSmart: boolean
  isAutoGroup?: boolean
  rules: unknown[]
  parentId: string | null
  sortOrder: number
  trackIds: string[]
  sourceIds: Record<string, string>
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface SyncPull {
  cursor: number
  tracks: Track[]
  playlists: Playlist[]
  deletedTrackIds: string[]
  deletedPlaylistIds: string[]
}

/** A partial patch — only present keys are written desktop-side. */
export interface TrackPatch {
  id: string
  contentHash?: string
  updatedAt: string // ISO-8601 UTC — gates last-writer-wins
  rating?: number
  energy?: number | null
  mood?: number | null
  comment?: string
  color?: string
  tags?: string[]
  customTags?: Record<string, string>
  cuePoints?: CuePoint[]
  beatgrid?: BeatgridMarker[]
  analysedBeatgrid?: Beatgrid | null
}

export interface PlaylistPatch {
  id: string
  updatedAt: string
  deleted?: boolean
  name?: string
  color?: string
  trackIds?: string[]
}

export interface SyncPushPayload {
  tracks?: TrackPatch[]
  playlists?: PlaylistPatch[]
}

export interface SyncPushResult {
  appliedTracks: number
  skippedTracks: number
  appliedPlaylists: number
  skippedPlaylists: number
  cursor: number
}

/** GET /media/peaks — bands are 0..255 (divide by 255). */
export interface PeaksData {
  v: 1
  trackId: string
  contentHash: string | null
  buckets: number
  durationSec: number
  peaks: number[]
  low: number[]
  mid: number[]
  high: number[]
}
