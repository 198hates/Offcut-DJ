import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Track, Playlist, LibraryStats, ImportResult, ExportResult, IntegrationId } from '../shared/types'

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
        renamePlaylist: (id: string, name: string) => Promise<void>
        deletePlaylist: (id: string) => Promise<void>
        addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
        scanMissingFiles: () => Promise<Track[]>
      }
    }
  }
}
