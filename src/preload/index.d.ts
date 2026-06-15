import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Track, Playlist, LibraryStats, ImportResult, ExportResult, IntegrationId,
  AppSettings, SmartRule, RunningOrder, EditLineage, CutHistory,
  PlayerStatus, CapturedTrack, ProLinkNetworkIface, ProLinkSessionState,
  EnrichInput, Seed, SeedCandidate, DiscoverOptions, DiscoverResult, DiscoverProgress, IdentityResult, PreviewResult, BandcampEmbed,
  StoredCandidate, LineageExportOptions, LineageExportResult, LineageStatus, LibraryTrackRef,
  StemsStatus, StemPaths, StemSeparateResult, StemProgress, UsbExport, BeatgridMarker, CuePoint,
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
        onSyncProgress: (cb: (p: { playlist: string; playlistIndex: number; playlistTotal: number; track: string; trackIndex: number; trackTotal: number; action: 'link' | 'copy' }) => void) => () => void
      }
      audio: {
        readFile: (filePath: string) => Promise<ArrayBuffer>
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
        choosePath: (title: string, isDirectory: boolean) => Promise<string | null>
        openInFinder: (path: string) => Promise<void>
      }
      prolink: {
        getNetworkInterfaces: () => Promise<ProLinkNetworkIface[]>
        getSessionState: () => Promise<{ state: ProLinkSessionState; playerStatuses: PlayerStatus[]; capturedTracks: CapturedTrack[] }>
        start: (ifaceAddress?: string) => Promise<{ ok: boolean; error?: string }>
        stop: () => Promise<{ ok: boolean; capturedTracks: CapturedTrack[] }>
        onStatusUpdate: (cb: (_e: unknown, statuses: PlayerStatus[]) => void) => () => void
        onTrackCaptured: (cb: (_e: unknown, track: CapturedTrack) => void) => () => void
        onError: (cb: (_e: unknown, message: string) => void) => () => void
        onSessionState: (cb: (_e: unknown, payload: { state: ProLinkSessionState; playerStatuses: PlayerStatus[]; capturedTracks: CapturedTrack[] }) => void) => () => void
        onTrackUpdated: (cb: (_e: unknown, track: CapturedTrack) => void) => () => void
        importUnownedTrack: (capturedId: string) => Promise<{ ok: boolean; localTrackId?: string; error?: string }>
        saveSession: (name?: string) => Promise<{ ok: boolean; playlist?: Playlist; error?: string }>
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
    }
  }
}
