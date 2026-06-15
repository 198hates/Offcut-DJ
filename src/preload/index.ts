import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Track, Playlist, IntegrationId, AppSettings, SmartRule, PlayerStatus, CapturedTrack, ProLinkNetworkIface, EnrichInput, Seed, SeedCandidate, DiscoverOptions, DiscoverResult, DiscoverProgress, IdentityResult, PreviewResult, BandcampEmbed, StoredCandidate, LineageExportOptions, LineageExportResult, LineageStatus, LibraryTrackRef, StemsStatus, StemPaths, StemSeparateResult, StemProgress, UsbExport, AiSearchFilter, AiSeqTrack, AiSequenceResult, AiTidyTrack, AiTidyResult, AiDigResult } from '../shared/types'

const api = {
  library: {
    getTracks: () => ipcRenderer.invoke('library:getTracks'),
    getPlaylists: () => ipcRenderer.invoke('library:getPlaylists'),
    getStats: () => ipcRenderer.invoke('library:getStats'),
    updateTrack: (patch: Partial<Track> & { id: string }) =>
      ipcRenderer.invoke('library:updateTrack', patch),
    bulkUpdateTracks: (ids: string[], patch: Partial<Track>) =>
      ipcRenderer.invoke('library:bulkUpdateTracks', ids, patch),
    deleteTrack: (id: string) => ipcRenderer.invoke('library:deleteTrack', id),
    deleteTracks: (ids: string[]) => ipcRenderer.invoke('library:deleteTracks', ids),
    importFromPath: (integrationId: IntegrationId, filePath?: string) =>
      ipcRenderer.invoke('library:importFromPath', integrationId, filePath),
    exportToPath: (integrationId: IntegrationId, filePath?: string) =>
      ipcRenderer.invoke('library:exportToPath', integrationId, filePath),
    createPlaylist: (name: string) => ipcRenderer.invoke('library:createPlaylist', name),
    createSmartPlaylist: (name: string, rules: SmartRule[]) =>
      ipcRenderer.invoke('library:createSmartPlaylist', name, rules),
    updateSmartPlaylistRules: (id: string, name: string, rules: SmartRule[]) =>
      ipcRenderer.invoke('library:updateSmartPlaylistRules', id, name, rules),
    renamePlaylist: (id: string, name: string) =>
      ipcRenderer.invoke('library:renamePlaylist', id, name),
    updatePlaylistColor: (id: string, color: string) =>
      ipcRenderer.invoke('library:updatePlaylistColor', id, color),
    recordPlay: (id: string, opts?: { mixedFrom?: string; deckId?: 'A' | 'B' }) =>
      ipcRenderer.invoke('library:recordPlay', id, opts),
    getCutHistory: (trackId: string) =>
      ipcRenderer.invoke('library:getCutHistory', trackId),
    updateEditLineage: (trackId: string, lineage: import('../shared/types').EditLineage) =>
      ipcRenderer.invoke('library:updateEditLineage', trackId, lineage),
    getPlayHistory: (weeks?: number) =>
      ipcRenderer.invoke('library:getPlayHistory', weeks) as Promise<{ day: string; count: number }[]>,
    deletePlaylist: (id: string) => ipcRenderer.invoke('library:deletePlaylist', id),
    reorderPlaylistTracks: (playlistId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('library:reorderPlaylistTracks', playlistId, orderedIds),
    addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
      ipcRenderer.invoke('library:addTracksToPlaylist', playlistId, trackIds),
    replaceTrackInPlaylists: (removeId: string, keepId: string) =>
      ipcRenderer.invoke('library:replaceTrackInPlaylists', removeId, keepId),
    removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) =>
      ipcRenderer.invoke('library:removeTracksFromPlaylist', playlistId, trackIds),
    beatModelStatus: () => ipcRenderer.invoke('library:beatModelStatus'),
    warmBeatModel: () => ipcRenderer.invoke('library:warmBeatModel'),
    analyzeBeats: (trackId: string) => ipcRenderer.invoke('library:analyzeBeats', trackId),
    exportPlaylistM3U: (playlistId: string) => ipcRenderer.invoke('library:exportPlaylistM3U', playlistId),
    exportPlaylistCSV: (playlistId: string) => ipcRenderer.invoke('library:exportPlaylistCSV', playlistId),
    writeTagsToFile: (trackId: string) =>
      ipcRenderer.invoke('library:writeTagsToFile', trackId),
    writeTagsBulk: (trackIds: string[]) =>
      ipcRenderer.invoke('library:writeTagsBulk', trackIds),
    previewPathMapping: (from: string, to: string) =>
      ipcRenderer.invoke('library:previewPathMapping', from, to),
    applyPathMapping: (from: string, to: string) =>
      ipcRenderer.invoke('library:applyPathMapping', from, to),
    getWatchFolders: () => ipcRenderer.invoke('library:getWatchFolders'),
    setWatchFolders: (paths: string[]) => ipcRenderer.invoke('library:setWatchFolders', paths),
    scanMissingFiles: () => ipcRenderer.invoke('library:scanMissingFiles'),
    autoLocateMissing: (searchDir?: string) => ipcRenderer.invoke('library:autoLocateMissing', searchDir),
    rekordboxDbStatus: () => ipcRenderer.invoke('library:rekordboxDbStatus'),
    importFromRekordboxDb: (dbPath?: string) =>
      ipcRenderer.invoke('library:importFromRekordboxDb', dbPath),
    exportToRekordboxDb: (dbPath?: string) =>
      ipcRenderer.invoke('library:exportToRekordboxDb', dbPath),
    runAutoGroup: (clusters: { name: string; trackIds: string[] }[]) =>
      ipcRenderer.invoke('library:runAutoGroup', clusters),
    createSet: (name: string) => ipcRenderer.invoke('library:createSet', name),
    createChapter: (setId: string, name: string, color: string) =>
      ipcRenderer.invoke('library:createChapter', setId, name, color),
    reorderChapters: (setId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('library:reorderChapters', setId, orderedIds),
    getRunningOrders: () =>
      ipcRenderer.invoke('library:getRunningOrders'),
    createRunningOrder: (title: string) =>
      ipcRenderer.invoke('library:createRunningOrder', title),
    updateRunningOrder: (id: string, patch: Partial<import('../shared/types').RunningOrder>) =>
      ipcRenderer.invoke('library:updateRunningOrder', id, patch),
    deleteRunningOrder: (id: string) =>
      ipcRenderer.invoke('library:deleteRunningOrder', id),
    exportOrderPDF: (id: string) =>
      ipcRenderer.invoke('library:exportOrderPDF', id) as Promise<{ saved: boolean; path?: string }>,
    getOrCreateSessionPlaylist: (): Promise<import('../shared/types').Playlist> =>
      ipcRenderer.invoke('library:getOrCreateSessionPlaylist'),
    getHistoryPlaylists: (): Promise<import('../shared/types').Playlist[]> =>
      ipcRenderer.invoke('library:getHistoryPlaylists'),
    exportCueSheet: (playlistId: string): Promise<{ saved: boolean; path?: string }> =>
      ipcRenderer.invoke('library:exportCueSheet', playlistId),
    mergePlaylists: (sourceIds: string[], targetName: string): Promise<import('../shared/types').Playlist> =>
      ipcRenderer.invoke('library:mergePlaylists', sourceIds, targetName),
    shufflePlaylist: (playlistId: string): Promise<void> =>
      ipcRenderer.invoke('library:shufflePlaylist', playlistId),
    diffPlaylists: (playlistAId: string, playlistBId: string): Promise<string[]> =>
      ipcRenderer.invoke('library:diffPlaylists', playlistAId, playlistBId),
    fetchDiscogsMetadata: (trackId: string): Promise<{ ok: boolean; updated?: import('../shared/types').Track; error?: string }> =>
      ipcRenderer.invoke('library:fetchDiscogsMetadata', trackId),
    lookupAcoustId: (trackId: string, fingerprint: string, durationSecs: number): Promise<{ ok: boolean; updated?: import('../shared/types').Track; error?: string }> =>
      ipcRenderer.invoke('library:lookupAcoustId', trackId, fingerprint, durationSecs),
    findPioneerUsb: (): Promise<string | null> =>
      ipcRenderer.invoke('library:findPioneerUsb'),
    browseForUsb: (): Promise<string | null> =>
      ipcRenderer.invoke('library:browseForUsb'),
    readUsbHistory: (usbRoot: string) =>
      ipcRenderer.invoke('library:readUsbHistory', usbRoot)
  },
  rekordboxUsb: {
    /** Volume roots of any mounted prepared Rekordbox USBs. */
    find: (): Promise<string[]> => ipcRenderer.invoke('rekordboxUsb:find'),
    browse: (): Promise<string | null> => ipcRenderer.invoke('rekordboxUsb:browse'),
    read: (usbRoot: string): Promise<UsbExport | { error: string }> =>
      ipcRenderer.invoke('rekordboxUsb:read', usbRoot),
    listVolumes: (): Promise<{ root: string; name: string; hasRekordbox: boolean }[]> =>
      ipcRenderer.invoke('rekordboxUsb:listVolumes'),
    initialize: (usbRoot: string): Promise<{ pdbPath: string; created: boolean } | { error: string }> =>
      ipcRenderer.invoke('rekordboxUsb:initialize', usbRoot),
    exists: (usbRoot: string): Promise<boolean> => ipcRenderer.invoke('rekordboxUsb:exists', usbRoot),
    importBackup: (
      backupRoot: string,
      includeAnalysis = true
    ): Promise<{ tracksImported: number; playlistsImported: number; errors: string[] } | { error: string }> =>
      ipcRenderer.invoke('rekordboxUsb:importBackup', backupRoot, includeAnalysis),
    onImportProgress: (cb: (p: { phase: 'tracks' | 'playlists'; current: number; total: number }) => void): (() => void) => {
      const h = (_e: unknown, p: Parameters<typeof cb>[0]): void => cb(p)
      ipcRenderer.on('rekordboxUsb:importProgress', h)
      return () => ipcRenderer.removeListener('rekordboxUsb:importProgress', h)
    },
    eject: (usbRoot: string): Promise<{ ejected: true } | { error: string }> =>
      ipcRenderer.invoke('rekordboxUsb:eject', usbRoot),
    onVolumesChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('rekordboxUsb:volumesChanged', h)
      return () => ipcRenderer.removeListener('rekordboxUsb:volumesChanged', h)
    },
    writePlaylist: (
      usbRoot: string,
      name: string,
      trackIds: number[]
    ): Promise<{ pdbPath: string; backupPath: string; playlistId: number; entryCount: number } | { error: string }> =>
      ipcRenderer.invoke('rekordboxUsb:writePlaylist', usbRoot, name, trackIds),
    syncPlaylists: (
      usbRoot: string,
      playlists: {
        name: string
        tracks: {
          artist: string; title: string; audioFilePath: string; bpm: number; durationSec: number
          beatgrid?: import('../shared/types').BeatgridMarker[]; bitrate?: number; year?: number
          key?: string; album?: string; genre?: string; cuePoints?: import('../shared/types').CuePoint[]
        }[]
      }[],
      mode?: 'replace' | 'add'
    ): Promise<
      { backupPath: string | null; playlists: { name: string; tracks: number }[]; totalTracks: number; skipped: string[] }
      | { error: string }
    > => ipcRenderer.invoke('rekordboxUsb:syncPlaylists', usbRoot, playlists, mode),
    onSyncProgress: (cb: (p: { playlist: string; playlistIndex: number; playlistTotal: number; track: string; trackIndex: number; trackTotal: number; action: 'link' | 'copy' }) => void): (() => void) => {
      const h = (_e: unknown, p: Parameters<typeof cb>[0]): void => cb(p)
      ipcRenderer.on('rekordboxUsb:syncProgress', h)
      return () => ipcRenderer.removeListener('rekordboxUsb:syncProgress', h)
    }
  },
  audio: {
    readFile: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('audio:readFile', filePath),
    decodePcm: (filePath: string, sampleRate?: number): Promise<{ samples: Float32Array; sampleRate: number }> =>
      ipcRenderer.invoke('audio:decodePcm', filePath, sampleRate),
    readTags: (filePath: string) =>
      ipcRenderer.invoke('audio:readTags', filePath),
    readArtwork: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke('audio:readArtwork', filePath)
  },
  engine: {
    /** True if the native Rust audio engine addon is loaded and ready. */
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('engine:isAvailable'),
    listOutputDevices: (): Promise<string[]> =>
      ipcRenderer.invoke('engine:listOutputDevices'),

    // ── Lifecycle ──────────────────────────────────────────────────────────
    load: (deckId: string, filePath: string): Promise<{
      duration: number
      peaks: number[]
      detailPeaks: number[]
      lowPeaks: number[]
      midPeaks: number[]
      highPeaks: number[]
    }> => ipcRenderer.invoke('engine:load', deckId, filePath),

    // ── Playback (fire-and-forget) ──────────────────────────────────────────
    play:  (deckId: string, fromMs?: number) => ipcRenderer.send('engine:play', deckId, fromMs),
    pause: (deckId: string)                  => ipcRenderer.send('engine:pause', deckId),
    seek:  (deckId: string, ms: number)      => ipcRenderer.send('engine:seek', deckId, ms),
    scrubBegin: (deckId: string) => ipcRenderer.send('engine:scrubBegin', deckId),
    scrubEnd:   (deckId: string) => ipcRenderer.send('engine:scrubEnd', deckId),

    // ── Settings ───────────────────────────────────────────────────────────
    setVolume:    (deckId: string, v: number)        => ipcRenderer.send('engine:setVolume', deckId, v),
    setRate:      (deckId: string, r: number)        => ipcRenderer.send('engine:setRate', deckId, r),
    setKeylock:   (deckId: string, v: boolean)       => ipcRenderer.send('engine:setKeylock', deckId, v),
    setEqGain:    (deckId: string, band: string, db: number) => ipcRenderer.send('engine:setEqGain', deckId, band, db),
    setStemGain:  (deckId: string, kind: string, db: number) => ipcRenderer.send('engine:setStemGain', deckId, kind, db),
    setStemMuted: (deckId: string, kind: string, muted: boolean) => ipcRenderer.send('engine:setStemMuted', deckId, kind, muted),
    setStemSoloed:(deckId: string, kind: string, soloed: boolean) => ipcRenderer.send('engine:setStemSoloed', deckId, kind, soloed),
    loadStems:    (deckId: string, paths: Record<string, string>): Promise<void> => ipcRenderer.invoke('engine:loadStems', deckId, paths),
    unloadStems:  (deckId: string) => ipcRenderer.send('engine:unloadStems', deckId),
    hasStems:     (deckId: string): Promise<boolean> => ipcRenderer.invoke('engine:hasStems', deckId),
    syncTo:       (deckId: string, masterDeckId: string, ratio: number, phaseSecs: number) => ipcRenderer.send('engine:syncTo', deckId, masterDeckId, ratio, phaseSecs),
    updateSync:   (deckId: string, ratio: number, phaseSecs: number) => ipcRenderer.send('engine:updateSync', deckId, ratio, phaseSecs),
    clearSync:    (deckId: string) => ipcRenderer.send('engine:clearSync', deckId),
    isSynced:     (deckId: string): Promise<boolean> => ipcRenderer.invoke('engine:isSynced', deckId),

    // ── Loop ───────────────────────────────────────────────────────────────
    setLoop:   (deckId: string, startMs: number, endMs: number) => ipcRenderer.send('engine:setLoop', deckId, startMs, endMs),
    clearLoop: (deckId: string) => ipcRenderer.send('engine:clearLoop', deckId),

    // ── Output ─────────────────────────────────────────────────────────────
    setOutputDevice: (deckId: string, deviceId: string): Promise<void> =>
      ipcRenderer.invoke('engine:setOutputDevice', deckId, deviceId),

    // ── Master-bus recording ────────────────────────────────────────────────
    recordStart: (): Promise<string> => ipcRenderer.invoke('engine:recordStart'),
    recordStop:  (): Promise<{ path: string; seconds: number }> =>
      ipcRenderer.invoke('engine:recordStop'),

    // ── Polled getters ──────────────────────────────────────────────────────
    getTime:  (deckId: string): Promise<number> => ipcRenderer.invoke('engine:getTime', deckId),
    getLevel: (deckId: string): Promise<number> => ipcRenderer.invoke('engine:getLevel', deckId),

    // ── Push events from native engine ─────────────────────────────────────
    onTimeUpdate: (deckId: string, cb: (time: number, level?: number) => void): (() => void) => {
      const handler = (_e: unknown, id: string, time: number, level?: number) => {
        if (id === deckId) cb(time, level)
      }
      ipcRenderer.on('engine:timeUpdate', handler)
      return () => ipcRenderer.removeListener('engine:timeUpdate', handler)
    },
    onEnded: (deckId: string, cb: () => void): (() => void) => {
      const handler = (_e: unknown, id: string) => { if (id === deckId) cb() }
      ipcRenderer.on('engine:ended', handler)
      return () => ipcRenderer.removeListener('engine:ended', handler)
    },
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:save', patch),
    getDetectedPaths: (): Promise<Record<string, string>> =>
      ipcRenderer.invoke('settings:getDetectedPaths'),
    choosePath: (title: string, isDirectory: boolean): Promise<string | null> =>
      ipcRenderer.invoke('settings:choosePath', title, isDirectory),
    openInFinder: (path: string): Promise<void> =>
      ipcRenderer.invoke('settings:openInFinder', path)
  },
  prolink: {
    getNetworkInterfaces: (): Promise<ProLinkNetworkIface[]> =>
      ipcRenderer.invoke('prolink:getNetworkInterfaces'),
    getSessionState: (): Promise<{ state: string; playerStatuses: PlayerStatus[]; capturedTracks: CapturedTrack[] }> =>
      ipcRenderer.invoke('prolink:getSessionState'),
    start: (ifaceAddress?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('prolink:start', ifaceAddress),
    stop: (): Promise<{ ok: boolean; capturedTracks: CapturedTrack[] }> =>
      ipcRenderer.invoke('prolink:stop'),
    onStatusUpdate: (cb: (_e: unknown, statuses: PlayerStatus[]) => void): (() => void) => {
      ipcRenderer.on('prolink:statusUpdate', cb)
      return () => ipcRenderer.removeListener('prolink:statusUpdate', cb)
    },
    onTrackCaptured: (cb: (_e: unknown, track: CapturedTrack) => void): (() => void) => {
      ipcRenderer.on('prolink:trackCaptured', cb)
      return () => ipcRenderer.removeListener('prolink:trackCaptured', cb)
    },
    onError: (cb: (_e: unknown, message: string) => void): (() => void) => {
      ipcRenderer.on('prolink:error', cb)
      return () => ipcRenderer.removeListener('prolink:error', cb)
    },
    onSessionState: (cb: (_e: unknown, payload: { state: string; playerStatuses: PlayerStatus[]; capturedTracks: CapturedTrack[] }) => void): (() => void) => {
      ipcRenderer.on('prolink:sessionState', cb)
      return () => ipcRenderer.removeListener('prolink:sessionState', cb)
    },
    onTrackUpdated: (cb: (_e: unknown, track: CapturedTrack) => void): (() => void) => {
      ipcRenderer.on('prolink:trackUpdated', cb)
      return () => ipcRenderer.removeListener('prolink:trackUpdated', cb)
    },
    importUnownedTrack: (capturedId: string): Promise<{ ok: boolean; localTrackId?: string; error?: string }> =>
      ipcRenderer.invoke('prolink:importUnownedTrack', capturedId),
    saveSession: (name?: string): Promise<{ ok: boolean; playlist?: Playlist; error?: string }> =>
      ipcRenderer.invoke('prolink:saveSession', name),
  },
  lineage: {
    status: (): Promise<LineageStatus> => ipcRenderer.invoke('lineage:status'),
    enrich: (input: EnrichInput): Promise<Seed | null> =>
      ipcRenderer.invoke('lineage:enrich', input),
    searchSeeds: (input: { artist?: string; title?: string }): Promise<SeedCandidate[]> =>
      ipcRenderer.invoke('lineage:searchSeeds', input),
    discover: (seed: Seed, opts?: DiscoverOptions): Promise<DiscoverResult> =>
      ipcRenderer.invoke('lineage:discover', seed, opts),
    onProgress: (cb: (p: DiscoverProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: DiscoverProgress): void => cb(p)
      ipcRenderer.on('lineage:progress', handler)
      return () => ipcRenderer.removeListener('lineage:progress', handler)
    },
    identify: (input: { filePath?: string; artist?: string; title?: string }): Promise<IdentityResult | null> =>
      ipcRenderer.invoke('lineage:identify', input),
    preview: (track: LibraryTrackRef): Promise<PreviewResult> =>
      ipcRenderer.invoke('lineage:preview', track),
    bandcampPreview: (track: LibraryTrackRef): Promise<BandcampEmbed | null> =>
      ipcRenderer.invoke('lineage:bandcampPreview', track),
    bandcampEmbed: (url: string): Promise<BandcampEmbed | null> =>
      ipcRenderer.invoke('lineage:bandcampEmbed', url),
    listNew: (): Promise<StoredCandidate[]> => ipcRenderer.invoke('lineage:listNew'),
    listSaved: (): Promise<StoredCandidate[]> => ipcRenderer.invoke('lineage:listSaved'),
    save: (key: string): Promise<void> => ipcRenderer.invoke('lineage:save', key),
    dismiss: (key: string): Promise<void> => ipcRenderer.invoke('lineage:dismiss', key),
    loadRekordbox: (xmlPath: string): Promise<void> =>
      ipcRenderer.invoke('lineage:loadRekordbox', xmlPath),
    loadSerato: (cratePath: string): Promise<string[]> =>
      ipcRenderer.invoke('lineage:loadSerato', cratePath),
    reloadLibrary: (): Promise<boolean> => ipcRenderer.invoke('lineage:reloadLibrary'),
    exportCrate: (opts?: LineageExportOptions): Promise<LineageExportResult> =>
      ipcRenderer.invoke('lineage:exportCrate', opts)
  },
  stems: {
    status: (): Promise<StemsStatus> => ipcRenderer.invoke('stems:status'),
    cached: (trackId: string): Promise<StemPaths | null> =>
      ipcRenderer.invoke('stems:cached', trackId),
    separate: (trackId: string, filePath: string): Promise<StemSeparateResult> =>
      ipcRenderer.invoke('stems:separate', trackId, filePath),
    clear: (trackId: string): Promise<boolean> => ipcRenderer.invoke('stems:clear', trackId),
    onProgress: (cb: (p: StemProgress) => void): (() => void) => {
      const handler = (_e: unknown, p: StemProgress): void => cb(p)
      ipcRenderer.on('stems:progress', handler)
      return () => ipcRenderer.removeListener('stems:progress', handler)
    }
  },
  ai: {
    status: (): Promise<{ enabled: boolean; hasKey: boolean }> =>
      ipcRenderer.invoke('ai:status'),
    nlSearch: (
      query: string,
      facets: { genres: string[]; keys: string[] }
    ): Promise<{ filter?: AiSearchFilter; error?: string }> =>
      ipcRenderer.invoke('ai:nlSearch', query, facets),
    sequenceSet: (
      tracks: AiSeqTrack[],
      intent?: string
    ): Promise<{ result?: AiSequenceResult; error?: string }> =>
      ipcRenderer.invoke('ai:sequenceSet', tracks, intent),
    tidyMetadata: (
      tracks: AiTidyTrack[]
    ): Promise<{ results?: AiTidyResult[]; error?: string }> =>
      ipcRenderer.invoke('ai:tidyMetadata', tracks),
    digContext: (
      seed: { artist: string; title: string }
    ): Promise<{ result?: AiDigResult; error?: string }> =>
      ipcRenderer.invoke('ai:digContext', seed)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
