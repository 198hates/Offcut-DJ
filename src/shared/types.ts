export type IntegrationId = 'rekordbox' | 'serato' | 'traktor' | 'apple-music' | 'engine-dj' | 'm3u' | 'virtualdj' | 'prolink'

// ── Running Order ─────────────────────────────────────────────────────────────

export type TransitionKind = 'blend' | 'cut' | 'echo-out' | 'loop-roll'

export interface PlannedTransition {
  kind: TransitionKind
  bars?: number   // length of the blend in bars
}

export interface OrderEntry {
  id: string              // stable UUID for drag-and-drop identity
  trackId: string
  plannedTransition: PlannedTransition | null   // transition INTO the next entry
  note: string | null     // "drop this if the room is slow"
  flexible: boolean       // swap-in candidate — not yet committed
}

export interface Annotation {
  id: string
  atEntryId: string       // the entry this annotation follows
  text: string
}

export interface RunningOrder {
  id: string
  catalogNum: number      // N° 001, N° 002 …
  title: string           // "Basement · Saturday, 28 June"
  entries: OrderEntry[]
  annotations: Annotation[]
  createdAt: string
  updatedAt: string
}

// ── Cut history / provenance ──────────────────────────────────────────────────

/** One timestamped play — recorded automatically each time a track is loaded */
export interface PlayEvent {
  id: string
  at: string                // ISO 8601 timestamp
  mixedFrom: string | null  // track ID of what played before on that deck
  mixedInto: string | null  // track ID of what played after (filled retrospectively)
  deckId: 'A' | 'B' | null
}

/** Whether this file is an edit of another recording */
export interface EditLineage {
  isEdit: boolean
  originalId: string | null   // track ID of the source recording
  versionLabel: string | null // "extended intro", "vox dub", etc.
}

/** Full cut history for one track — returned by library:getCutHistory */
export interface CutHistory {
  trackId: string
  plays: PlayEvent[]          // most-recent-first, capped at 50
  editLineage: EditLineage
  playCount: number
  firstPlayedAt: string | null
  lastPlayedAt: string | null
}

export interface CuePoint {
  index: number
  type: 'hotcue' | 'memory' | 'loop'
  positionMs: number
  /** Loop end position in ms — only set when type === 'loop' */
  endMs?: number
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

// ── Phrase / song structure ───────────────────────────────────────────────────

export type PhraseLabel =
  | 'intro'
  | 'verse'
  | 'buildup'
  | 'drop'
  | 'chorus'
  | 'breakdown'
  | 'bridge'
  | 'outro'

export interface PhraseSegment {
  label: PhraseLabel
  startMs: number
  endMs: number
  /** 0–1 confidence from the analyser */
  confidence: number
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
  year: number | null     // release year, e.g. 2023
  label: string           // record label, e.g. "Drumcode"
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
  updatedAt: string | null     // ISO timestamp of last metadata edit
  comment: string
  tags: string[]
  customTags: Record<string, string>   // user-defined key→value fields
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  /** v2 beatgrid — produced by Quantiser pipeline; null until analysed */
  analysedBeatgrid: Beatgrid | null
  /** provenance: is this an edit of another track? */
  editLineage: EditLineage | null
  sourceIds: Partial<Record<IntegrationId, string>>
  // ── File-level metadata (filled on import / watch-folder add) ────────────
  fileSize: number | null      // bytes
  fileType: string | null      // 'mp3' | 'flac' | 'aiff' | 'wav' | 'm4a' | …
  sampleRate: number | null    // Hz e.g. 44100
  bitDepth: number | null      // 16 | 24 | 32
  // ── Per-track gain trim ───────────────────────────────────────────────────
  gainDb: number | null        // dB offset for auto-gain; 0 = unity, null = not analysed
  // ── Phrase / song structure ───────────────────────────────────────────────
  /** Phrase segments detected by the phrase analyser */
  phrases: PhraseSegment[] | null
}

export type SmartRuleField = 'bpm' | 'key' | 'genre' | 'artist' | 'album' | 'year' | 'label' | 'rating' | 'title' | 'comment' | 'durationSeconds' | 'dateAdded' | 'playCount' | 'lastPlayedAt' | 'energy' | 'danceability' | 'mood' | 'tags' | 'customTag'
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

// ── ProLink B2B Capture ───────────────────────────────────────────────────────

/** Play state of a CDJ on the network */
export type ProLinkPlayState = 'empty' | 'loading' | 'playing' | 'paused' | 'cued' | 'looping' | 'ended' | 'unknown'

/** Live status of a single CDJ/XDJ player on the network */
export interface PlayerStatus {
  deviceId: number
  playState: ProLinkPlayState
  isOnAir: boolean
  isMaster: boolean
  isSync: boolean
  trackBPM: number | null
  beat: number         // beat within measure, 1–4 (0 when no track)
  trackId: number      // 0 = empty
  title: string | null
  artist: string | null
  album: string | null
  label: string | null
  genre: string | null
  key: string | null
  year: number | null
  lastUpdated: string  // ISO timestamp
}

/** A track that was captured as "played" during a ProLink session */
export interface CapturedTrack {
  id: string
  player: number
  capturedAt: string   // ISO timestamp
  title: string
  artist: string
  album: string
  label: string
  genre: string
  key: string | null
  bpm: number | null
  year: number | null
  durationSeconds: number | null
  inLibrary: boolean       // true = matched to a track already in OD-01 library
  localTrackId: string | null
  sourcedFrom: 'prolink'
}

/** State of the ProLink capture session */
export type ProLinkSessionState = 'idle' | 'connecting' | 'active' | 'error' | 'stopping'

export interface ProLinkNetworkIface {
  name: string
  address: string
  netmask: string
  mac: string
}
