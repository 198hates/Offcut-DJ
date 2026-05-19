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
    deletePlaylist: (id: string) => ipcRenderer.invoke('library:deletePlaylist', id),
    addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
      ipcRenderer.invoke('library:addTracksToPlaylist', playlistId, trackIds),
    scanMissingFiles: () => ipcRenderer.invoke('library:scanMissingFiles'),
    rekordboxDbStatus: () => ipcRenderer.invoke('library:rekordboxDbStatus'),
    importFromRekordboxDb: (dbPath?: string) =>
      ipcRenderer.invoke('library:importFromRekordboxDb', dbPath),
    exportToRekordboxDb: (dbPath?: string) =>
      ipcRenderer.invoke('library:exportToRekordboxDb', dbPath)
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
