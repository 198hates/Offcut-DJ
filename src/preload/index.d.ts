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
        updatePlaylistColor: (id: string, color: string) => Promise<void>
        recordPlay: (id: string) => Promise<Track>
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
