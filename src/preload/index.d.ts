import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Track, Playlist, LibraryStats, ImportResult, ExportResult, IntegrationId, AppSettings, SmartRule } from '../shared/types'

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
        deletePlaylist: (id: string) => Promise<void>
        addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
        scanMissingFiles: () => Promise<Track[]>
        rekordboxDbStatus: () => Promise<{ available: boolean; path: string }>
        importFromRekordboxDb: (dbPath?: string) => Promise<ImportResult>
        exportToRekordboxDb: (dbPath?: string) => Promise<ExportResult>
      }
      audio: {
        readFile: (filePath: string) => Promise<ArrayBuffer>
        readTags: (filePath: string) => Promise<{
          bpm: number | null; key: string | null; title: string | null
          artist: string | null; album: string | null; genre: string | null
          comment: string | null
        } | null>
      }
      settings: {
        get: () => Promise<AppSettings>
        save: (patch: Partial<AppSettings>) => Promise<AppSettings>
        getDetectedPaths: () => Promise<Record<string, string>>
        choosePath: (title: string, isDirectory: boolean) => Promise<string | null>
        openInFinder: (path: string) => Promise<void>
      }
    }
  }
}
