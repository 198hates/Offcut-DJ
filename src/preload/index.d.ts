import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Track, Playlist, LibraryStats, ImportResult, ExportResult, IntegrationId,
  AppSettings, SmartRule, RunningOrder, EditLineage, CutHistory,
  EnrichInput, Seed, SeedCandidate, DiscoverOptions, DiscoverResult, DiscoverProgress, IdentityResult, PreviewResult, BandcampEmbed,
  StoredCandidate, LineageExportOptions, LineageExportResult, LineageStatus, LibraryTrackRef,
  StemsStatus, StemPaths, StemSeparateResult, StemProgress, UsbExport, UsbPreflight, BeatgridMarker, CuePoint,
  AiSearchFilter, AiSeqTrack, AiSequenceResult, AiTidyTrack, AiTidyResult, AiDigResult, AiAgentEvent,
  BackupInfo, SystemInfo, CastDevice, CastStatus,
  SyncStatus, SyncPairingInfo,
  SetSummary, SetDetail, SetPatch, SetListFilter, UsbHistoryPreview, UsbImportResult,
} from '../shared/types'

/** USB history types — mirrored from pioneer-usb/history-reader */
interface UsbPlayedTrack {
  title: string; artist: string; bpm: number | null; key: string | null
  durationSeconds: number | null; position: number; localTrackId: string | null
}
interface UsbPlayedSet {
  name: string; usbId: string; date: string | null; tracks: UsbPlayedTrack[]
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      library: {
        getTracks: () => Promise<Track[]>
        getPlaylists: () => Promise<Playlist[]>
        getStats: () => Promise<LibraryStats>
        updateTrack: (patch: Partial<Track> & { id: string }) => Promise<Track>
        bulkUpdateTracks: (ids: string[], patch: Partial<Track>) => Promise<Track[]>
        deleteTrack: (id: string) => Promise<void>
        deleteTracks: (ids: string[]) => Promise<void>
        importFromPath: (integrationId: IntegrationId, filePath?: string) => Promise<ImportResult>
        exportToPath: (integrationId: IntegrationId, filePath?: string) => Promise<ExportResult>
        createPlaylist: (name: string) => Promise<Playlist>
        createSmartPlaylist: (name: string, rules: SmartRule[]) => Promise<Playlist>
        updateSmartPlaylistRules: (id: string, name: string, rules: SmartRule[]) => Promise<void>
        renamePlaylist: (id: string, name: string) => Promise<void>
        updatePlaylistColor: (id: string, color: string) => Promise<void>
        recordPlay: (id: string, opts?: { mixedFrom?: string; deckId?: 'A' | 'B' }) => Promise<Track>
        getCutHistory: (trackId: string) => Promise<CutHistory>
        updateEditLineage: (trackId: string, lineage: EditLineage) => Promise<void>
        getPlayHistory: (weeks?: number) => Promise<{ day: string; count: number }[]>
        deletePlaylist: (id: string) => Promise<void>
        reorderPlaylistTracks: (playlistId: string, orderedIds: string[]) => Promise<void>
        addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
        replaceTrackInPlaylists: (removeId: string, keepId: string) => Promise<number>
        removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
        beatModelStatus: () => Promise<{ available: boolean; path: string }>
        warmBeatModel: () => Promise<void>
        analyzeBeats: (trackId: string) => Promise<Track>
        exportPlaylistM3U: (playlistId: string) => Promise<void>
        exportPlaylistCSV: (playlistId: string) => Promise<void>
        writeTagsToFile: (trackId: string) => Promise<{ success: boolean; skipped?: boolean; error?: string }>
        writeTagsBulk: (trackIds: string[]) => Promise<{ succeeded: number; failed: number; skipped: number }>
        previewPathMapping: (from: string, to: string) => Promise<number>
        applyPathMapping: (from: string, to: string) => Promise<number>
        getWatchFolders: () => Promise<string[]>
        setWatchFolders: (paths: string[]) => Promise<void>
        scanMissingFiles: () => Promise<Track[]>
        autoLocateMissing: (searchDir?: string) => Promise<{ trackId: string; foundPath: string }[]>
        rekordboxDbStatus: () => Promise<{ available: boolean; path: string }>
        importFromRekordboxDb: (dbPath?: string) => Promise<ImportResult>
        exportToRekordboxDb: (dbPath?: string) => Promise<ExportResult>
        runAutoGroup: (clusters: { name: string; trackIds: string[] }[]) => Promise<void>
        createSet: (name: string) => Promise<Playlist>
        createChapter: (setId: string, name: string, color: string) => Promise<Playlist>
        reorderChapters: (setId: string, orderedIds: string[]) => Promise<void>
        getRunningOrders: () => Promise<RunningOrder[]>
        createRunningOrder: (title: string) => Promise<RunningOrder>
        updateRunningOrder: (id: string, patch: Partial<RunningOrder>) => Promise<RunningOrder>
        deleteRunningOrder: (id: string) => Promise<void>
        exportOrderPDF: (id: string) => Promise<{ saved: boolean; path?: string }>
        getOrCreateSessionPlaylist: () => Promise<Playlist>
        getHistoryPlaylists: () => Promise<Playlist[]>
        exportCueSheet: (playlistId: string) => Promise<{ saved: boolean; path?: string }>
        mergePlaylists: (sourceIds: string[], targetName: string) => Promise<Playlist>
        shufflePlaylist: (playlistId: string) => Promise<void>
        diffPlaylists: (playlistAId: string, playlistBId: string) => Promise<string[]>
        fetchDiscogsMetadata: (trackId: string) => Promise<{ ok: boolean; updated?: Track; error?: string }>
        lookupAcoustId: (trackId: string, fingerprint: string, durationSecs: number) => Promise<{ ok: boolean; updated?: Track; error?: string }>
        findPioneerUsb: () => Promise<string | null>
        browseForUsb: () => Promise<string | null>
        readUsbHistory: (usbRoot: string) => Promise<UsbPlayedSet[]>
      }
      rekordboxUsb: {
        find: () => Promise<string[]>
        browse: () => Promise<string | null>
        read: (usbRoot: string) => Promise<UsbExport | { error: string }>
        listVolumes: () => Promise<{ root: string; name: string; hasRekordbox: boolean }[]>
        preflight: (usbRoot: string, benchmark?: boolean) => Promise<UsbPreflight | { error: string }>
        initialize: (usbRoot: string) => Promise<{ pdbPath: string; created: boolean } | { error: string }>
        exists: (usbRoot: string) => Promise<boolean>
        importBackup: (backupRoot: string, includeAnalysis?: boolean) => Promise<{ tracksImported: number; playlistsImported: number; errors: string[] } | { error: string }>
        onImportProgress: (cb: (p: { phase: 'tracks' | 'playlists'; current: number; total: number }) => void) => () => void
        eject: (usbRoot: string) => Promise<{ ejected: true } | { error: string }>
        onVolumesChanged: (cb: () => void) => () => void
        writePlaylist: (usbRoot: string, name: string, trackIds: number[]) => Promise<
          { pdbPath: string; backupPath: string; playlistId: number; entryCount: number } | { error: string }
        >
        syncPlaylists: (
          usbRoot: string,
          playlists: { name: string; tracks: { artist: string; title: string; audioFilePath: string; bpm: number; durationSec: number; beatgrid?: BeatgridMarker[]; bitrate?: number; year?: number; key?: string; album?: string; genre?: string; cuePoints?: CuePoint[] }[] }[],
          mode?: 'replace' | 'add'
        ) => Promise<
          { backupPath: string | null; playlists: { name: string; tracks: number }[]; totalTracks: number; skipped: string[] } | { error: string }
        >
        onSyncProgress: (cb: (p: { playlist: string; playlistIndex: number; playlistTotal: number; track: string; trackIndex: number; trackTotal: number; action: 'link' | 'copy'; totalBytes: number; copiedBytes: number }) => void) => () => void
      }
      sync: {
        status: () => Promise<SyncStatus>
        setEnabled: (enabled: boolean) => Promise<SyncStatus | { error: string }>
        pairing: () => Promise<SyncPairingInfo>
        unpairAll: () => Promise<SyncStatus>
        removeDevice: (id: string) => Promise<SyncStatus>
        onLibraryChanged: (cb: () => void) => () => void
      }
      audio: {
        readFile: (filePath: string) => Promise<ArrayBuffer>
        decodePcm: (filePath: string, sampleRate?: number) => Promise<{ samples: Float32Array; sampleRate: number }>
        readTags: (filePath: string) => Promise<{
          bpm: number | null; key: string | null; title: string | null
          artist: string | null; album: string | null; genre: string | null
          comment: string | null
        } | null>
        readArtwork: (filePath: string) => Promise<string | null>
      }
      settings: {
        get: () => Promise<AppSettings>
        save: (patch: Partial<AppSettings>) => Promise<AppSettings>
        getDetectedPaths: () => Promise<Record<string, string>>
        systemInfo: () => Promise<SystemInfo>
        choosePath: (title: string, isDirectory: boolean) => Promise<string | null>
        openInFinder: (path: string) => Promise<void>
      }
      /** Google Cast — discover devices + stream the master mix to one. */
      cast: {
        discover: () => Promise<CastDevice[]>
        start: (device: CastDevice, sourceFile: string) => Promise<void>
        startMaster: (device: CastDevice) => Promise<void>
        stop: () => Promise<void>
        status: () => Promise<CastStatus>
      }
      /** Library backups — versioned snapshots + restore. */
      backup: {
        list: () => Promise<BackupInfo[]>
        create: (label?: string) => Promise<BackupInfo>
        restore: (name: string) => Promise<void>
        delete: (name: string) => Promise<boolean>
      }
      /** Lineage — library expansion / crate-digging engine bridge. */
      lineage: {
        status: () => Promise<LineageStatus>
        enrich: (input: EnrichInput) => Promise<Seed | null>
        searchSeeds: (input: { artist?: string; title?: string }) => Promise<SeedCandidate[]>
        discover: (seed: Seed, opts?: DiscoverOptions) => Promise<DiscoverResult>
        onProgress: (cb: (p: DiscoverProgress) => void) => () => void
        identify: (input: { filePath?: string; artist?: string; title?: string }) => Promise<IdentityResult | null>
        preview: (track: LibraryTrackRef) => Promise<PreviewResult>
        bandcampPreview: (track: LibraryTrackRef) => Promise<BandcampEmbed | null>
        bandcampEmbed: (url: string) => Promise<BandcampEmbed | null>
        listNew: () => Promise<StoredCandidate[]>
        listSaved: () => Promise<StoredCandidate[]>
        save: (key: string) => Promise<void>
        dismiss: (key: string) => Promise<void>
        loadRekordbox: (xmlPath: string) => Promise<void>
        loadSerato: (cratePath: string) => Promise<string[]>
        reloadLibrary: () => Promise<boolean>
        exportCrate: (opts?: LineageExportOptions) => Promise<LineageExportResult>
      }
      /** Stem separation (Demucs) bridge. */
      stems: {
        status: () => Promise<StemsStatus>
        cached: (trackId: string) => Promise<StemPaths | null>
        separate: (trackId: string, filePath: string) => Promise<StemSeparateResult>
        clear: (trackId: string) => Promise<boolean>
        onProgress: (cb: (p: StemProgress) => void) => () => void
      }
      /** AI features bridge (Claude). Metadata only — never audio. */
      ai: {
        status: () => Promise<{ enabled: boolean; hasKey: boolean }>
        nlSearch: (
          query: string,
          facets: { genres: string[]; keys: string[] }
        ) => Promise<{ filter?: AiSearchFilter; error?: string }>
        sequenceSet: (
          tracks: AiSeqTrack[],
          intent?: string
        ) => Promise<{ result?: AiSequenceResult; error?: string }>
        tidyMetadata: (
          tracks: AiTidyTrack[]
        ) => Promise<{ results?: AiTidyResult[]; error?: string }>
        digContext: (
          seed: { artist: string; title: string }
        ) => Promise<{ result?: AiDigResult; error?: string }>
        agentRun: (
          query: string,
          history: { role: 'user' | 'assistant'; content: string }[],
          runId: number
        ) => Promise<boolean>
        onAgentEvent: (cb: (e: AiAgentEvent) => void) => () => void
      }
      /** Native Rust audio engine IPC bridge (id·2026·009). */
      engine: {
        isAvailable: () => Promise<boolean>
        listOutputDevices: () => Promise<string[]>
        // Lifecycle
        load: (deckId: string, filePath: string) => Promise<{
          duration: number
          peaks: number[]
          detailPeaks: number[]
          lowPeaks: number[]
          midPeaks: number[]
          highPeaks: number[]
        }>
        // Playback (fire-and-forget)
        play:  (deckId: string, fromMs?: number) => void
        pause: (deckId: string) => void
        seek:  (deckId: string, ms: number) => void
        scrubBegin: (deckId: string) => void
        scrubEnd:   (deckId: string) => void
        // Settings
        setVolume:    (deckId: string, v: number) => void
        setRate:      (deckId: string, r: number) => void
        setKeylock:   (deckId: string, v: boolean) => void
        setEqGain:    (deckId: string, band: string, db: number) => void
        setFilter:    (deckId: string, knob: number) => void
        setDelay:     (deckId: string, timeMs: number, feedback: number, mix: number, enabled: boolean) => void
        setStemGain:  (deckId: string, kind: string, db: number) => void
        setStemMuted: (deckId: string, kind: string, muted: boolean) => void
        setStemSoloed:(deckId: string, kind: string, soloed: boolean) => void
        loadStems:    (deckId: string, paths: Record<string, string>) => Promise<void>
        unloadStems:  (deckId: string) => void
        hasStems:     (deckId: string) => Promise<boolean>
        syncTo:       (deckId: string, masterDeckId: string, ratio: number, phaseSecs: number) => void
        updateSync:   (deckId: string, ratio: number, phaseSecs: number) => void
        clearSync:    (deckId: string) => void
        isSynced:     (deckId: string) => Promise<boolean>
        // Loop
        setLoop:   (deckId: string, startMs: number, endMs: number) => void
        clearLoop: (deckId: string) => void
        // Output
        setOutputDevice: (deckId: string, deviceId: string) => Promise<void>
        // Master-bus recording (native engine)
        recordStart: () => Promise<string>
        recordStop: () => Promise<{ path: string; seconds: number }>
        // Polled getters
        getTime:  (deckId: string) => Promise<number>
        getLevel: (deckId: string) => Promise<number>
        // Push events from native engine
        /** `time` is seconds; `level` is the post-fader RMS (0–1) piggy-backed on the same event. */
        onTimeUpdate: (deckId: string, cb: (time: number, level?: number) => void) => () => void
        onEnded:      (deckId: string, cb: () => void) => () => void
      }
      setHistory: {
        list: (filter?: SetListFilter) => Promise<SetSummary[]>
        get: (id: string) => Promise<SetDetail | null>
        update: (id: string, patch: SetPatch) => Promise<SetDetail | null>
        delete: (id: string) => Promise<boolean>
        listUsb: (usbRoot: string) => Promise<UsbHistoryPreview[] | { error: string }>
        importUsb: (usbRoot: string, refs: string[]) => Promise<UsbImportResult | { error: string }>
      }
    }
  }
}
