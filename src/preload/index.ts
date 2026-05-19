import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Track, Playlist, IntegrationId } from '../shared/types'

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
    renamePlaylist: (id: string, name: string) =>
      ipcRenderer.invoke('library:renamePlaylist', id, name),
    deletePlaylist: (id: string) => ipcRenderer.invoke('library:deletePlaylist', id),
    addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
      ipcRenderer.invoke('library:addTracksToPlaylist', playlistId, trackIds),
    scanMissingFiles: () => ipcRenderer.invoke('library:scanMissingFiles')
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
