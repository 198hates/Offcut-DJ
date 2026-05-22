export type IntegrationId = 'rekordbox' | 'serato' | 'traktor' | 'apple-music' | 'engine-dj' | 'm3u' | 'virtualdj'

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

// ── Beatgrid v2 contract ──────────────────────────────────────────────────────
// Richer structure produced by the Quantiser pipeline.
// Stored as `analysed_beatgrid` JSON blob alongside the legacy `beatgrid` array.

export type BeatgridSource =
  | 'beat-this'   // Beat This! ONNX model output
  | 'essentia'    // Essentia BPM tracker
  | 'manual'      // user-edited in the BeatgridEditor
  | 'tags'        // read from ID3 / file metadata
  | 'mock'        // MockQuantiser (unit tests / dev)

export interface Beat {
  positionMs: number
  /** bar-relative beat index 0–3 */
  beatInBar: number
  /** model activation or confidence (0–1) */
  confidence: number
}

export interface Bar {
  positionMs: number
  /** instantaneous BPM at the start of this bar (60000 / beat_interval_ms) */
  bpm: number
  /** sequential bar index from track start (0-based) */
  barIndex: number
}

export interface Beatgrid {
  beats: Beat[]
  bars: Bar[]
  /** positions (ms) of every 4-beat downbeat for quick waveform overlay */
  downbeats: number[]
  source: BeatgridSource
  /** median BPM across the track */
  medianBpm: number
  /** first beat offset from 0 (ms) */
  firstBeatMs: number
  /** true when the whole track is constant tempo within ±0.5 BPM */
  isConstantTempo: boolean
  /** ISO timestamp of when this beatgrid was computed */
  computedAt: string
}

// ── Quantiser interface ───────────────────────────────────────────────────────

export interface QuantiserHints {
  /** user-stated BPM (from file tags or manual entry) — optional nudge */
  bpmHint?: number
  /** ISO 8601 timestamp budget — abort analysis after this many ms */
  timeBudgetMs?: number
}

export interface TriageResult {
  /** true when the quantiser has enough data to run full analysis */
  canAnalyse: boolean
  /** reason string if canAnalyse === false */
  reason?: string
  /** estimated analysis duration in ms */
  estimatedMs?: number
}

export interface Quantiser {
  /** quick pre-flight check before committing to a full analysis */
  triage(track: Track, hints?: QuantiserHints): Promise<TriageResult>
  /** full beatgrid analysis; calls onProgress(0–1) during processing */
  analyse(
    track: Track,
    hints?: QuantiserHints,
    onProgress?: (p: number) => void
  ): Promise<Beatgrid>
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
  mood: number | null          // −1.0 (dark/tense) → +1.0 (bright/euphoric), null = unset
  playCount: number
  lastPlayedAt: string | null
  dateAdded: string
  comment: string
  tags: string[]
  customTags: Record<string, string>   // user-defined key→value fields
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  /** v2 beatgrid — produced by Quantiser pipeline; null until analysed */
  analysedBeatgrid: Beatgrid | null
  sourceIds: Partial<Record<IntegrationId, string>>
}

export type SmartRuleField = 'bpm' | 'key' | 'genre' | 'artist' | 'album' | 'rating' | 'title' | 'comment' | 'durationSeconds' | 'dateAdded' | 'playCount' | 'lastPlayedAt' | 'energy' | 'danceability' | 'mood' | 'tags' | 'customTag'
export type SmartRuleOp = 'is' | 'is_not' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'between' | 'in_last_days'

export interface SmartRule {
  field: SmartRuleField
  op: SmartRuleOp
  value: string | number | [number, number]
  customTagKey?: string   // only used when field === 'customTag'
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
