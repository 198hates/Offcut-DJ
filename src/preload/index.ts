import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Track, IntegrationId, AppSettings, SmartRule, PlayerStatus, CapturedTrack, ProLinkNetworkIface } from '../shared/types'

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
  audio: {
    readFile: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('audio:readFile', filePath),
    readTags: (filePath: string) =>
      ipcRenderer.invoke('audio:readTags', filePath),
    readArtwork: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke('audio:readArtwork', filePath)
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
