import { create } from 'zustand'
import { useToastStore } from './toastStore'
import type { Track, Playlist, LibraryStats, IntegrationId, ImportResult, ExportResult, SmartRule } from '@shared/types'

export interface Filters {
  bpmMin: number | null
  bpmMax: number | null
  keys: string[]
  genres: string[]
  ratingMin: number | null
}

const DEFAULT_FILTERS: Filters = {
  bpmMin: null,
  bpmMax: null,
  keys: [],
  genres: [],
  ratingMin: null
}

interface LibraryState {
  tracks: Track[]
  playlists: Playlist[]
  stats: LibraryStats | null
  selectedTrackIds: Set<string>
  activePlaylistId: string | null
  searchQuery: string
  filters: Filters
  isLoading: boolean
  isImporting: boolean
  isExporting: boolean
  isDraggingTracks: boolean
  draggingTrackIds: string[]

  loadLibrary: () => Promise<void>
  updateTrack: (patch: Partial<Track> & { id: string }) => Promise<void>
  bulkUpdateTracks: (ids: string[], patch: Partial<Track>) => Promise<void>
  deleteTrack: (id: string) => Promise<void>
  deleteTracks: (ids: string[]) => Promise<void>
  importFromIntegration: (integrationId: IntegrationId, filePath?: string) => Promise<ImportResult>
  exportToIntegration: (integrationId: IntegrationId, filePath?: string) => Promise<ExportResult>
  createPlaylist: (name: string) => Promise<void>
  createSmartPlaylist: (name: string, rules: SmartRule[]) => Promise<void>
  updateSmartPlaylistRules: (id: string, name: string, rules: SmartRule[]) => Promise<void>
  renamePlaylist: (id: string, name: string) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
  setSelectedTrackIds: (ids: Set<string>) => void
  setActivePlaylistId: (id: string | null) => void
  setDragging: (ids: string[]) => void
  clearDragging: () => void
  setSearchQuery: (q: string) => void
  setFilters: (f: Partial<Filters>) => void
  resetFilters: () => void
  filteredTracks: () => Track[]
  availableKeys: () => string[]
  availableGenres: () => string[]
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  playlists: [],
  stats: null,
  selectedTrackIds: new Set(),
  activePlaylistId: null,
  searchQuery: '',
  filters: DEFAULT_FILTERS,
  isLoading: false,
  isImporting: false,
  isExporting: false,
  isDraggingTracks: false,
  draggingTrackIds: [],

  loadLibrary: async () => {
    set({ isLoading: true })
    try {
      const [tracks, playlists, stats] = await Promise.all([
        window.api.library.getTracks(),
        window.api.library.getPlaylists(),
        window.api.library.getStats()
      ])
      set({ tracks, playlists, stats, isLoading: false })
    } catch (err) {
      set({ isLoading: false })
    }
  },

  updateTrack: async (patch) => {
    const updated = await window.api.library.updateTrack(patch)
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === updated.id ? updated : t)) }))
  },

  bulkUpdateTracks: async (ids, patch) => {
    const updated = await window.api.library.bulkUpdateTracks(ids, patch)
    set((s) => {
      const map = new Map(updated.map((t) => [t.id, t]))
      return { tracks: s.tracks.map((t) => map.get(t.id) ?? t) }
    })
  },

  deleteTrack: async (id) => {
    await window.api.library.deleteTrack(id)
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      selectedTrackIds: new Set([...s.selectedTrackIds].filter((i) => i !== id))
    }))
  },

  deleteTracks: async (ids) => {
    await window.api.library.deleteTracks(ids)
    const idSet = new Set(ids)
    set((s) => ({
      tracks: s.tracks.filter((t) => !idSet.has(t.id)),
      selectedTrackIds: new Set([...s.selectedTrackIds].filter((i) => !idSet.has(i)))
    }))
  },

  importFromIntegration: async (integrationId, filePath) => {
    set({ isImporting: true })
    const { show } = useToastStore.getState()
    try {
      const result = await window.api.library.importFromPath(integrationId, filePath)
      if (result.errors[0] === 'Import cancelled') { set({ isImporting: false }); return result }
      if (result.tracksImported > 0 || result.playlistsImported > 0) {
        await get().loadLibrary()
        show(
          `Imported ${result.tracksImported.toLocaleString()} track${result.tracksImported !== 1 ? 's' : ''}` +
          (result.playlistsImported > 0 ? ` and ${result.playlistsImported} playlist${result.playlistsImported !== 1 ? 's' : ''}` : ''),
          'success'
        )
      } else if (result.errors.length) {
        show(`Import failed: ${result.errors[0]}`, 'error')
      } else {
        show('Nothing to import', 'info')
      }
      if (result.errors.length && result.tracksImported > 0)
        show(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''} during import`, 'error')
      return result
    } catch (err) {
      show(`Import error: ${(err as Error).message}`, 'error')
      return { tracksImported: 0, playlistsImported: 0, errors: [(err as Error).message] }
    } finally {
      set({ isImporting: false })
    }
  },

  exportToIntegration: async (integrationId, filePath) => {
    set({ isExporting: true })
    const { show } = useToastStore.getState()
    try {
      const result = await window.api.library.exportToPath(integrationId, filePath)
      if (result.cancelled) { set({ isExporting: false }); return result }
      if (result.tracksExported > 0) show(`Exported ${result.tracksExported.toLocaleString()} tracks to ${integrationId}`, 'success')
      else if (result.errors.length) show(`Export failed: ${result.errors[0]}`, 'error')
      return result
    } catch (err) {
      show(`Export error: ${(err as Error).message}`, 'error')
      return { tracksExported: 0, playlistsExported: 0, errors: [(err as Error).message], cancelled: false }
    } finally {
      set({ isExporting: false })
    }
  },

  createPlaylist: async (name) => {
    const pl = await window.api.library.createPlaylist(name)
    set((s) => ({ playlists: [...s.playlists, pl] }))
  },

  createSmartPlaylist: async (name, rules) => {
    const pl = await window.api.library.createSmartPlaylist(name, rules)
    set((s) => ({ playlists: [...s.playlists, pl] }))
  },

  updateSmartPlaylistRules: async (id, name, rules) => {
    await window.api.library.updateSmartPlaylistRules(id, name, rules)
    await get().loadLibrary()
  },

  renamePlaylist: async (id, name) => {
    await window.api.library.renamePlaylist(id, name)
    set((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? { ...p, name } : p)) }))
  },

  deletePlaylist: async (id) => {
    await window.api.library.deletePlaylist(id)
    set((s) => ({
      playlists: s.playlists.filter((p) => p.id !== id),
      activePlaylistId: s.activePlaylistId === id ? null : s.activePlaylistId
    }))
  },

  addTracksToPlaylist: async (playlistId, trackIds) => {
    await window.api.library.addTracksToPlaylist(playlistId, trackIds)
    set((s) => ({
      playlists: s.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, trackIds: [...new Set([...p.trackIds, ...trackIds])] }
          : p
      )
    }))
  },

  setSelectedTrackIds: (ids) => set({ selectedTrackIds: ids }),
  setActivePlaylistId: (id) => set({ activePlaylistId: id }),
  setDragging: (ids) => set({ isDraggingTracks: true, draggingTrackIds: ids }),
  clearDragging: () => set({ isDraggingTracks: false, draggingTrackIds: [] }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),

  filteredTracks: () => {
    const { tracks, activePlaylistId, playlists, searchQuery, filters } = get()
    let result = tracks

    if (activePlaylistId) {
      const pl = playlists.find((p) => p.id === activePlaylistId)
      if (pl) {
        const idSet = new Set(pl.trackIds)
        result = result.filter((t) => idSet.has(t.id))
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          t.genre.toLowerCase().includes(q) ||
          t.comment.toLowerCase().includes(q)
      )
    }

    if (filters.bpmMin != null) result = result.filter((t) => t.bpm != null && t.bpm >= filters.bpmMin!)
    if (filters.bpmMax != null) result = result.filter((t) => t.bpm != null && t.bpm <= filters.bpmMax!)
    if (filters.keys.length > 0) result = result.filter((t) => t.key != null && filters.keys.includes(t.key))
    if (filters.genres.length > 0) result = result.filter((t) => filters.genres.includes(t.genre))
    if (filters.ratingMin != null) result = result.filter((t) => t.rating >= filters.ratingMin!)

    return result
  },

  availableKeys: () => {
    const keys = new Set(get().tracks.map((t) => t.key).filter(Boolean) as string[])
    const ORDER = ['1A','2A','3A','4A','5A','6A','7A','8A','9A','10A','11A','12A','1B','2B','3B','4B','5B','6B','7B','8B','9B','10B','11B','12B']
    return ORDER.filter((k) => keys.has(k))
  },

  availableGenres: () => {
    const genres = [...new Set(get().tracks.map((t) => t.genre).filter(Boolean))]
    return genres.sort()
  }
}))
