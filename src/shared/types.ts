export type IntegrationId = 'rekordbox' | 'serato' | 'traktor' | 'apple-music' | 'engine-dj' | 'm3u' | 'virtualdj'

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
  /** 0–1 auto-cue detector confidence, when the cue was machine-generated. */
  confidence?: number
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
  // ── Audio-content similarity ──────────────────────────────────────────────
  /** Handcrafted audio feature vector (see lib/audioFeatures); null until analysed */
  embedding: number[] | null
}

// ── Library sync (mobile companion / multi-device) ─────────────────────────────

/** One collapsed change from the sync journal: the latest op for an entity. */
export interface SyncChange {
  entity: 'track' | 'playlist'
  entityId: string
  op: 'upsert' | 'delete'
  /** Monotonic journal sequence — use as the cursor for the next pull. */
  seq: number
}

/**
 * A delta (or, when pulling from cursor 0, a full snapshot) of everything that
 * changed in the library since a given cursor. `cursor` is the value to send on
 * the next pull. Deleted ids let a client drop entities that no longer exist.
 */
export interface SyncPull {
  cursor: number
  tracks: Track[]
  playlists: Playlist[]
  deletedTrackIds: string[]
  deletedPlaylistIds: string[]
}

/**
 * A prep edit pushed from the phone for one track. Only the keys present are
 * applied (a partial patch); `updatedAt` is when the phone made the edit and
 * gates a last-writer-wins merge against the desktop's copy. Tracks are matched
 * by `id`, falling back to `contentHash`. File-level metadata is desktop-owned
 * and intentionally not patchable from mobile.
 */
export interface TrackPatch {
  id: string
  contentHash?: string
  updatedAt: string
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

/**
 * A playlist edit pushed from the phone. Unknown ids create a new playlist;
 * `deleted` removes it; `trackIds` replaces membership in order. Gated by
 * last-writer-wins on `updatedAt` (except creation).
 */
export interface PlaylistPatch {
  id: string
  updatedAt: string
  deleted?: boolean
  name?: string
  color?: string
  trackIds?: string[]
  /** Smart-playlist rule set (phone can create/edit rule-based playlists). */
  isSmart?: boolean
  rules?: SmartRule[]
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
  /** Cursor after applying, so the phone can fast-forward past its own echo. */
  cursor: number
}

/** A phone (or other device) that has paired with this desktop. */
export interface SyncPairedDevice {
  id: string
  name: string
  firstSeen: string
  lastSeen: string
}

/** Current state of the phone-sync LAN server. */
export interface SyncStatus {
  enabled: boolean
  running: boolean
  port: number
  addresses: string[]
  devices: SyncPairedDevice[]
}

/** Pairing details shown to the user (QR + the address/token behind it). */
export interface SyncPairingInfo {
  uri: string
  host: string
  port: number
  addresses: string[]
  /** PNG data-URL of the pairing QR, or null if generation failed. */
  qr: string | null
}

/**
 * USB pre-flight report — capacity, filesystem suitability for CDJs, and a
 * measured speed benchmark used to estimate how long an export will take.
 */
export interface UsbPreflight {
  root: string
  capacityBytes: number | null
  freeBytes: number | null
  /** Normalised filesystem label, e.g. 'msdos' (FAT32), 'exfat', 'hfs', 'ntfs'. */
  filesystem: string | null
  /** Can a CDJ read this filesystem? null = unknown. */
  fsCompatible: boolean | null
  /** Sequential write throughput; null until the speed test has run. */
  writeMBps: number | null
  readMBps: number | null
  speedClass: 'fast' | 'adequate' | 'slow' | null
}

// ── Stem separation ───────────────────────────────────────────────────────────

/** The four stem buses produced by HT-Demucs (or a mock in dev). */
export type StemKind = 'drums' | 'bass' | 'vocals' | 'other'

/** Per-stem UI state — actual audio routing lives in the engine; this drives the UI. */
export interface StemState {
  muted: boolean
  soloed: boolean
  /** Gain trim in dB relative to the stem bus unity (−∞ to +6). */
  gainDb: number
}

/** Absolute file paths to a track's four separated stems. */
export type StemPaths = Record<StemKind, string>

/** Whether stem separation (Demucs) is available in the configured Python. */
export interface StemsStatus {
  available: boolean
  pythonPath: string
}

/** Result of a stems:separate request. */
export interface StemSeparateResult {
  ok: boolean
  paths?: StemPaths
  error?: string
}

/** Progress tick emitted on `stems:progress` during separation. */
export interface StemProgress {
  trackId: string
  percent: number
  label: string
}

// ── Automix decision model ────────────────────────────────────────────────────

/** Confidence band: how much the automix engine trusts itself on this transition. */
export type AutoMixBand = 'auto' | 'assisted' | 'handback'

/** Component scores that feed the composite confidence. */
export interface AutoMixScores {
  /** Mean beat confidence across the first 16 beats of the incoming track's intro. */
  grid: number
  /** Camelot harmonic compatibility (1.0 = perfect, 0.0 = tritone clash). */
  harmonic: number
  /** Tempo proximity (1.0 = identical BPM, 0.0 = 20+ BPM apart). */
  tempo: number
  /** Energy continuity (1.0 = same energy level, 0.0 = full 9-point range apart). */
  energy: number
}

export interface AutoMixDecision {
  fromTrackId: string
  toTrackId: string
  /** Composite confidence score 0–1. */
  confidence: number
  band: AutoMixBand
  /** Human-readable explanation of the weakest factor. */
  reason: string
  scores: AutoMixScores
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

/** Pioneer device settings written to DEVSETTING.DAT on USB export (mirrors the
 *  rekordbox device-settings panel). */
export interface UsbDeviceSettings {
  // DEVSETTING.DAT
  waveformColor: 'blue' | 'rgb' | '3band'
  waveformPosition: 'left' | 'center'
  keyDisplay: 'classic' | 'alphanumeric'
  overviewWaveform: 'half' | 'full'
  // MYSETTING2.DAT
  waveformDivisions: 'timescale' | 'phrase'
  jogDisplay: 'auto' | 'info' | 'simple' | 'artwork'
  // MYSETTING.DAT
  quantize: 'on' | 'off'
  quantizeBeat: '1' | '1/2' | '1/4' | '1/8'
  autoCue: 'on' | 'off'
  hotcueAutoload: 'off' | 'on' | 'rekordbox'
  timeMode: 'elapsed' | 'remain'
}

/** Custom colours for the exported RGB waveform (PWV5) — one per frequency band,
 *  as #rrggbb hex. Shown when the player is in RGB waveform mode. */
export interface UsbWaveformColors {
  low: string
  mid: string
  high: string
}

export interface AppSettings {
  rekordboxXmlPath: string
  rekordboxDbPath: string
  traktorCollectionPath: string
  seratoDir: string
  appleMusicXmlPath: string
  engineDjDbPath: string
  m3uExportDir: string
  /** Free Discogs personal access token — optional; raises the discovery rate limit. */
  discogsToken: string
  /** Free AcoustID application key — used for fingerprint identity lookups. */
  acoustidKey: string
  /** Free Last.fm API key — enables the "listeners also play" discovery route. */
  lastfmKey: string
  /** 1001Tracklists partner API key — enables the "played alongside" route. */
  tracklistsApiKey: string
  /** 1001Tracklists partner API base URL (paired with the key). */
  tracklistsApiBase: string
  /** Opt in to the fragile public 1001TL fallback when no partner API is set. */
  enableTracklistsScrape: boolean
  /** Python executable used to run Demucs for stem separation. */
  pythonPath: string
  theme: 'dark' | 'light' | 'system'
  defaultExportDir: string
  showWelcomeOnStartup: boolean
  /** Folders watched for new tracks (auto-import). */
  watchFolders: string[]
  lastImportedAt: string | null
  windowBounds: { x: number; y: number; width: number; height: number } | null
  /** Device settings written to the USB on export (waveform colour, key display…). */
  usbDeviceSettings: UsbDeviceSettings
  /** Per-band colours for the exported RGB waveform. */
  usbWaveformColors: UsbWaveformColors
  /** Beta: write Offcut hot cues / memory cues into the exported ANLZ files. */
  usbExportCues?: boolean
  /** Opt in to AI features (natural-language search, set building…). */
  aiEnabled?: boolean
  /** Anthropic API key for AI features. Only track metadata is ever sent — never audio. */
  anthropicApiKey?: string
  /** How many tracks to analyse at once. 0 = auto (derived from CPU cores). */
  analysisConcurrency?: number
  /** User-created/edited auto-cue templates (built-ins live in code). */
  cueTemplates?: CueTemplate[]
  /** Which auto-cue template is active (built-in id or a user template id). */
  activeCueTemplateId?: string
}

/** The five structural cue roles the auto-cue detector can emit. */
export type CueRole = 'mixIn' | 'build' | 'drop' | 'break' | 'outro'

/** How a single cue role is rendered when a template emits it. */
export interface CueRoleRule {
  /** Emit this cue role at all. */
  enabled: boolean
  color: string
  label: string
}

/**
 * A named, reusable auto-cue configuration: which roles to emit, their colours
 * and labels, and an overall sensitivity. Applied as a post-process over the
 * detector's output (sensitivity scales the detector's confidence thresholds).
 */
export interface CueTemplate {
  id: string
  name: string
  /** True for the shipped presets — read-only in the editor. */
  builtin?: boolean
  /** 0–1; 0.5 = default. Higher emits more cues (lower thresholds). */
  sensitivity: number
  roles: Record<CueRole, CueRoleRule>
}

/** A discovered Google Cast / Chromecast device. */
export interface CastDevice {
  name: string
  host: string
  port: number
  id: string
}

/** Current cast session state (audience-PA streaming). */
export interface CastStatus {
  casting: boolean
  device: string | null
  source: string | null
  error: string | null
}

/** Hardware summary for tuning analysis concurrency. */
export interface SystemInfo {
  cpuCount: number
  totalMemGB: number
  platform: string
  arch: string
}

/**
 * Structured filter produced by AI natural-language search. Every numeric field
 * is null when the query didn't constrain that dimension; the renderer maps the
 * non-null ones onto the Search page filter state.
 */
export interface AiSearchFilter {
  bpmMin: number | null
  bpmMax: number | null
  energyMin: number | null
  energyMax: number | null
  danceMin: number | null
  danceMax: number | null
  moodMin: number | null
  moodMax: number | null
  ratingMin: number | null
  ratingMax: number | null
  keys: string[]
  genres: string[]
  hasCues: boolean
  hasGrid: boolean
  unplayed: boolean
  sortBy: 'title' | 'bpm' | 'energy' | 'rating'
  explanation: string
}

/** Compact track metadata sent to the AI set-sequencer (no audio). */
export interface AiSeqTrack {
  id: string
  title: string
  artist: string
  genre: string
  bpm: number | null
  key: string | null        // Camelot
  energy: number | null     // 1–10
  mood: number | null       // −1…+1
  durationSecs: number | null
}

/** One placed track in an AI-sequenced set, with the reason it sits here. */
export interface AiSeqStep {
  trackId: string
  reason: string            // why this track follows the previous one
}

/** Result of ai:sequenceSet — a reasoned ordering of the given tracks. */
export interface AiSequenceResult {
  order: AiSeqStep[]        // full ordering, one step per input track
  arc: string               // one-paragraph narrative of the set's shape
}

/** Candidate track metadata sent to the AI metadata-tidy pass. */
export interface AiTidyTrack {
  id: string
  title: string
  artist: string
  album: string
  genre: string
}

/** Cleaned metadata returned by the AI tidy pass (one per input track). */
export interface AiTidyResult {
  trackId: string
  title: string
  artist: string
  genre: string
}

/** One artist/track the AI suggests digging into, from web-grounded research. */
export interface AiDigSuggestion {
  artist: string
  title: string       // may be "" when the suggestion is an artist, not a specific track
  why: string
}

/** A web source the AI cited while researching a seed. */
export interface AiDigSource {
  title: string
  url: string
}

/** Result of ai:digContext — web-grounded crate-digging context for a seed. */
export interface AiDigResult {
  summary: string                 // a few sentences on scene / era / label / sound
  suggestions: AiDigSuggestion[]  // specific things to dig into next
  sources: AiDigSource[]          // de-duplicated web citations
}

/**
 * Streamed events from the conversational AI agent (ai:agentRun). The agent
 * reasons over the library with tools; the renderer renders these as a
 * transcript. `runId` lets the renderer ignore events from a superseded run.
 */
export type AiAgentEvent =
  | { type: 'text'; runId: number; text: string }
  | { type: 'tool'; runId: number; tool: string; summary: string }
  | { type: 'tool_result'; runId: number; tool: string; summary: string; ok: boolean }
  | { type: 'library_changed'; runId: number }
  | { type: 'done'; runId: number }
  | { type: 'error'; runId: number; message: string }

/** A versioned library-database snapshot. */
export interface BackupInfo {
  name: string
  label: string | null
  sizeBytes: number
  createdAt: string
}

// ── Lineage (library expansion / crate-digging) ────────────────────────────
// Shared DTOs crossing the IPC bridge between the main-process engine and the
// renderer's lineage-web viewer.

/** Minimal track reference used for owned-library dedup. */
export interface LibraryTrackRef {
  artist: string
  title: string
}

/** A credited person (remixer / producer) from a Discogs release. */
export interface Credit {
  id: number | null
  name: string
}

/** A credited instrumentalist (bass, drums, keys…) — drives the "shared players" route. */
export interface PlayerCredit {
  id: number | null
  name: string
  /** The raw Discogs role string, e.g. "Bass", "Drums [Live]". */
  role?: string
}

/** A record label reference from a Discogs release. */
export interface LabelRef {
  id: number | null
  name: string
}

/** Whatever the user dropped in: a Discogs release id, or artist + title. */
export interface EnrichInput {
  discogsReleaseId?: number
  artist?: string
  title?: string
}

/**
 * One Discogs release match for the seed-disambiguation picker — so the user
 * can confirm *which* release a dig builds on instead of blindly taking the
 * first hit.
 */
export interface SeedCandidate {
  releaseId: number
  /** Best-effort artist, split from Discogs' "Artist – Title" line. */
  artist: string
  /** Best-effort title, split from Discogs' "Artist – Title" line. */
  title: string
  /** The raw Discogs combined line, kept as a fallback label. */
  raw: string
  year: number | null
  label: string | null
  format: string | null
  country: string | null
  thumb: string | null
}

/** The canonical, enriched form of the seed track — produced by enrich(). */
export interface Seed {
  releaseId: number | null
  artist: string
  title: string
  year: number | null
  labels: LabelRef[]
  styles: string[]
  genres: string[]
  remixers: Credit[]
  producers: Credit[]
  /** The release's primary artists (with ids) — drives the compilation route. */
  artists: Credit[]
  /** Credited instrumentalists — drives the "shared players" route. */
  players: PlayerCredit[]
}

/** One ranked discovery candidate — returned inside a direction's pool. */
export interface Candidate {
  key: string
  artist: string
  title: string
  label: string | null
  year: number | null
  discogs_id: number | null
  why: string
  score: number
  /** Which branch surfaced it (e.g. `person:123`, `label:45`, `listener`). */
  direction?: string | null
  /** The immediate seed it was discovered from. */
  seed_key?: string | null
  /** The original seed at the top of the dig chain. */
  root_seed_key?: string | null
  /** True when this track is already in the user's library (surfaced, not hidden). */
  owned?: boolean
}

/**
 * The route family a direction belongs to — drives the viewer's branch colour.
 * remix · label · players · listener · deezer · sample · comp · set
 */
export type RouteType =
  | 'remix'
  | 'label'
  | 'players'
  | 'listener'
  | 'deezer'
  | 'sample'
  | 'comp'
  | 'set'

/** One branch off a seed: a typed, titled, ranked pool the UI windows to 5. */
export interface Direction {
  id: string
  type: RouteType
  title: string
  pool: Candidate[]
}

/** User-set filters that steer what a dig surfaces. */
export interface DiscoverFilters {
  /** Only run these route types; undefined or empty = all routes. */
  routes?: RouteType[]
  /** Drop candidates released before this year (candidates with no year pass). */
  yearMin?: number | null
  /** Drop candidates released after this year (candidates with no year pass). */
  yearMax?: number | null
  /** Keep only candidates whose label contains this text (case-insensitive). */
  labelQuery?: string | null
  /** Include tracks already in your library (default false = exclude owned). */
  includeOwned?: boolean
}

/** Options for discover(). */
export interface DiscoverOptions {
  /** Max candidates per direction pool (default 24). */
  poolSize?: number
  /** Max branches returned, strongest first (default 8). */
  maxDirections?: number
  /** The original root seed key, preserved when promoting a sub-seed. */
  rootSeedKey?: string
  /** Route / year / label / owned filters. */
  filters?: DiscoverFilters
}

/** The seed echoed back by discover(), carrying its place in the dig chain. */
export interface DiscoverSeed {
  key: string
  artist: string
  title: string
  year: number | null
  rootSeedKey: string
}

/** Result of discover() — the seed's relationships grouped into directions. */
export interface DiscoverResult {
  seed: DiscoverSeed
  directions: Direction[]
}

/** Progress tick emitted on `lineage:progress` while discover() runs. */
export interface DiscoverProgress {
  done: number
  total: number
  label: string
}

export type CandidateStatus = 'new' | 'saved' | 'dismissed'

/** A persisted candidate row (adds review status + timestamp). */
export interface StoredCandidate extends Candidate {
  status: CandidateStatus
  found_at: string
}

/** "Open in" links, always present so the UI can handle the no-preview case. */
export interface PreviewLinks {
  youtube: string
  soundcloud: string
  bandcamp: string
}

/** Result of preview() — a 30s clip URL plus fallback links and cover art. */
export interface PreviewResult {
  source: 'deezer' | 'itunes' | null
  previewUrl: string | null
  externalUrl?: string
  /** iTunes store link — terms require showing this beside an iTunes preview. */
  storeUrl?: string
  artworkUrl?: string | null
  /** BPM from the matched Deezer track, when known (Deezer reports 0 if not). */
  bpm?: number | null
  links: PreviewLinks
}

/** Result of bandcampEmbed() / bandcampPreview() — official embed player. */
export interface BandcampEmbed {
  url: string
  embedSrc: string
  itemType: string
  itemId: string
}

/** Result of identify() — universal recording identity via MusicBrainz. */
export interface IdentityResult {
  mbid: string
  isrcs: string[]
  source: 'fingerprint' | 'metadata'
}

/** Result of deezerByIsrc() — an exact Deezer track from an ISRC. */
export interface DeezerTrack {
  id: number
  title: string
  preview: string
  link: string
}

/** A find to write into an exported crate playlist. */
export interface LineageExportFind {
  artist: string
  title: string
  location?: string
}

export interface LineageExportOptions {
  finds?: LineageExportFind[]
  name?: string
  outPath?: string
}

export interface LineageExportResult {
  saved: boolean
  path?: string
  count?: number
  cancelled?: boolean
  error?: string
}

export interface LineageStatus {
  /** A Discogs token is configured (raises the rate limit). */
  hasToken: boolean
  /** A Last.fm key is configured — the "listeners also play" route is live. */
  hasLastfm: boolean
  /** A 1001Tracklists *partner API* is configured — the "played alongside" route is live (the scrape is a no-op). */
  hasTracklists: boolean
}

// ── Rekordbox USB (prepared stick) ──────────────────────────────────────────

/** A track parsed from a prepared USB's export.pdb (DeviceSQL). */
export interface UsbTrack {
  id: number
  title: string
  artist: string
  album: string
  key: string
  genre: string
  bpm: number | null
  durationSeconds: number | null
  year: number | null
  rating: number
  /** Device-relative path of the audio file on the USB. */
  filePath: string
  /** Device-relative path of the ANLZ .DAT (beatgrid / cues). */
  analyzePath: string
}

/** A node in the USB's playlist tree — a folder (with children) or a playlist (with track ids). */
export interface UsbPlaylistNode {
  id: number
  name: string
  isFolder: boolean
  children?: UsbPlaylistNode[]
  trackIds?: number[]
}

/** The result of reading a prepared Rekordbox USB. */
export interface UsbExport {
  pdbPath: string
  trackCount: number
  tracks: UsbTrack[]
  playlists: UsbPlaylistNode[]
}

// ── Set History ─────────────────────────────────────────────────────────────
// A played set: an is_history playlist (ordered tracks) + set-level metadata.

export interface SetSummary {
  id: string
  playlistId: string | null
  title: string
  playedOn: string | null
  source: string
  venue: string | null
  residencyId: string | null
  rating: number | null
  vibe: string | null
  status: string // 'kept' | 'archived' | 'unsorted'
  trackCount: number | null
  durationSec: number | null
  avgBpm: number | null
  bpmMin: number | null
  bpmMax: number | null
  energyAvg: number | null
  harmonicPct: number | null
}

export interface SetTrack {
  trackId: string | null
  title: string
  artist: string
  bpm: number | null
  key: string | null
  durationSeconds: number | null
}

/** A→B handover deltas for spotting rough transitions. */
export interface SetTransition {
  index: number // the B track's position
  bpmDelta: number | null
  harmonic: boolean | null
}

export interface SetDetail extends SetSummary {
  device: string | null
  notes: string | null
  recordingPath: string | null
  tracks: SetTrack[]
  transitions: SetTransition[]
  debrief: string // auto-generated one-paragraph summary
}

export interface SetPatch {
  title?: string
  venue?: string | null
  rating?: number | null
  vibe?: string | null
  notes?: string | null
  status?: string
  residencyId?: string | null
}

export interface SetListFilter {
  includeArchived?: boolean
  residencyId?: string // scope to one residency
}

export interface Residency {
  id: string
  name: string
  venue: string
  color: string
  cadence: string | null
  notes: string | null
  setCount: number
}

export interface ResidencyPatch {
  name?: string
  venue?: string
  color?: string
  cadence?: string | null
  notes?: string | null
}

/** Rolling averages over a residency's sets — the baseline a new set compares to. */
export interface ResidencyRollup {
  setCount: number
  avgBpm: number | null
  avgTrackCount: number | null
  avgDurationSec: number | null
  avgHarmonicPct: number | null
  firstPlayedOn: string | null
  lastPlayedOn: string | null
}

/** A track's footprint across a residency: total plays, consecutive-from-latest
 *  streak (over-rotation signal), and how many sets ago it last appeared. */
export interface RotationTrack {
  trackId: string
  title: string
  artist: string
  plays: number
  streak: number
  lastAgo: number // sets since last played (0 = in the latest set)
}

export interface ResidencyDashboard {
  residency: Residency
  rollup: ResidencyRollup
  rotation: RotationTrack[]
}

/** One side of a set comparison — set_sessions metrics + a few computed ones. */
export interface SetCompareSide {
  id: string
  title: string
  playedOn: string | null
  trackCount: number
  durationSec: number | null
  tracksPerHour: number | null
  avgBpm: number | null
  bpmRange: number | null
  energyAvg: number | null
  harmonicPct: number | null
  keyDiversityPct: number | null // distinct keys / tracks
  roughTransitions: number
}

/** A→B set comparison: side-by-side metrics + the shared/unique track split. */
export interface SetComparison {
  a: SetCompareSide
  b: SetCompareSide
  shared: { trackId: string; title: string; artist: string }[]
  onlyA: { trackId: string; title: string; artist: string }[]
  onlyB: { trackId: string; title: string; artist: string }[]
}

/** A HISTORY set on a Pioneer stick, previewed before import. */
export interface UsbHistoryPreview {
  ref: string // dedupe key: `HISTORY NNN@<volume>`
  name: string
  playedOn: string | null
  trackCount: number
  matchedCount: number // resolved to the local library
  durationSec: number | null
  alreadyImported: boolean
}

export interface UsbImportResult {
  imported: { ref: string; name: string; trackCount: number; matchedCount: number }[]
}
