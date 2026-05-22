import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Track, IntegrationId, AppSettings, SmartRule } from '../shared/types'

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
    recordPlay: (id: string) =>
      ipcRenderer.invoke('library:recordPlay', id),
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
      ipcRenderer.invoke('library:reorderChapters', setId, orderedIds)
  },
  audio: {
    readFile: (filePath: string): Promise<ArrayBuffer> =>
      ipcRenderer.invoke('audio:readFile', filePath),
    readTags: (filePath: string) =>
      ipcRenderer.invoke('audio:readTags', filePath)
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
