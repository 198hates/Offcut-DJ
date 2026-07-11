import { create } from 'zustand'
import { useToastStore } from './toastStore'
import type { Track, Playlist, LibraryStats, IntegrationId, ImportResult, ExportResult, SmartRule } from '@shared/types'

// Returns all Camelot key strings compatible with the given key (same num ±1, relative mode)
function camelotCompatible(key: string): string[] {
  const m = key.toUpperCase().match(/^(\d{1,2})([AB])$/)
  if (!m) return [key.toUpperCase()]
  const num = parseInt(m[1]), band = m[2] as 'A' | 'B'
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1
  return [
    `${num}${band}`,
    `${wrap(num - 1)}${band}`,
    `${wrap(num + 1)}${band}`,
    `${num}${band === 'A' ? 'B' : 'A'}`,
  ]
}

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

export interface FnBusContext {
  harmonicKey: string | null   // stored when harmonic filter was activated
  bpmRef: number | null        // stored when range filter was activated
  moodRef: number | null       // stored when mood filter was activated (−1 to +1)
}

interface LibraryState {
  tracks: Track[]
  playlists: Playlist[]
  stats: LibraryStats | null
  selectedTrackIds: Set<string>
  activePlaylistId: string | null
  searchQuery: string
  filters: Filters
  fnBus: Set<string>
  fnBusContext: FnBusContext
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
  createPlaylist: (name: string) => Promise<Playlist>
  createSet: (name: string) => Promise<Playlist>
  createChapter: (setId: string, name: string, color: string) => Promise<Playlist>
  reorderChapters: (setId: string, orderedIds: string[]) => Promise<void>
  createSmartPlaylist: (name: string, rules: SmartRule[]) => Promise<void>
  updateSmartPlaylistRules: (id: string, name: string, rules: SmartRule[]) => Promise<void>
  renamePlaylist: (id: string, name: string) => Promise<void>
  updatePlaylistColor: (id: string, color: string) => Promise<void>
  reorderPlaylists: (orderedIds: string[]) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  reorderPlaylistTracks: (playlistId: string, orderedIds: string[]) => Promise<void>
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
  removeTracksFromPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
  setSelectedTrackIds: (ids: Set<string>) => void
  setActivePlaylistId: (id: string | null) => void
  setDragging: (ids: string[]) => void
  clearDragging: () => void
  setSearchQuery: (q: string) => void
  setFilters: (f: Partial<Filters>) => void
  resetFilters: () => void
  toggleFnBus: (key: string, context?: Partial<FnBusContext>) => void
  resetFnBus: () => void
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
  fnBus: new Set<string>(),
  fnBusContext: { harmonicKey: null, bpmRef: null, moodRef: null },
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
      // Backfill bit depth / sample rate for lossless tracks that came from
      // external libraries without it (self-limiting — skips once filled).
      void window.api.library.backfillFileMeta().then((n) => {
        if (n > 0) void window.api.library.getTracks().then((updated) => set({ tracks: updated }))
      }).catch(() => { /* non-fatal */ })
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
    return pl
  },

  createSet: async (name) => {
    const newSet = await window.api.library.createSet(name)
    set((s) => ({ playlists: [...s.playlists, newSet] }))
    return newSet
  },

  createChapter: async (setId, name, color) => {
    const chapter = await window.api.library.createChapter(setId, name, color)
    set((s) => ({ playlists: [...s.playlists, chapter] }))
    return chapter
  },

  reorderChapters: async (setId, orderedIds) => {
    await window.api.library.reorderChapters(setId, orderedIds)
    set((s) => ({
      playlists: s.playlists.map((p) => {
        const idx = orderedIds.indexOf(p.id)
        return idx >= 0 ? { ...p, sortOrder: idx } : p
      })
    }))
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

  updatePlaylistColor: async (id, color) => {
    await window.api.library.updatePlaylistColor(id, color)
    set((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? { ...p, color } : p)) }))
  },

  reorderPlaylists: async (orderedIds) => {
    await window.api.library.reorderPlaylists(orderedIds)
    // Reorder the array itself (not just sortOrder) — the sidebar's manual mode
    // renders in array order, so mutating the field alone had no visible effect.
    // Only the reordered playlists move; everything else keeps its position.
    set((s) => {
      const orderPos = new Map(orderedIds.map((id, i) => [id, i]))
      // The reordered playlists, in their new order, with refreshed sortOrder.
      const moved = s.playlists
        .filter((p) => orderPos.has(p.id))
        .sort((a, b) => orderPos.get(a.id)! - orderPos.get(b.id)!)
        .map((p) => ({ ...p, sortOrder: orderPos.get(p.id)! }))
      // Slot them back into the same array positions they occupied, leaving
      // smart playlists / folders / auto-groups untouched.
      let mi = 0
      const playlists = s.playlists.map((p) => (orderPos.has(p.id) ? moved[mi++] : p))
      return { playlists }
    })
  },

  deletePlaylist: async (id) => {
    await window.api.library.deletePlaylist(id)
    set((s) => ({
      playlists: s.playlists.filter((p) => p.id !== id),
      activePlaylistId: s.activePlaylistId === id ? null : s.activePlaylistId
    }))
  },

  reorderPlaylistTracks: async (playlistId, orderedIds) => {
    await window.api.library.reorderPlaylistTracks(playlistId, orderedIds)
    set((s) => ({
      playlists: s.playlists.map((p) =>
        p.id === playlistId ? { ...p, trackIds: orderedIds } : p
      )
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

  removeTracksFromPlaylist: async (playlistId, trackIds) => {
    await window.api.library.removeTracksFromPlaylist(playlistId, trackIds)
    const idSet = new Set(trackIds)
    set((s) => ({
      playlists: s.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, trackIds: p.trackIds.filter((id) => !idSet.has(id)) }
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

  toggleFnBus: (key, context) => set((s) => {
    const next = new Set(s.fnBus)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    return {
      fnBus: next,
      fnBusContext: context ? { ...s.fnBusContext, ...context } : s.fnBusContext
    }
  }),
  resetFnBus: () => set({ fnBus: new Set(), fnBusContext: { harmonicKey: null, bpmRef: null, moodRef: null } }),

  filteredTracks: () => {
    const { tracks, activePlaylistId, playlists, searchQuery, filters, fnBus, fnBusContext } = get()
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

    // ── FN-BUS filters ─────────────────────────────────────────────────────
    if (fnBus.has('harmonic') && fnBusContext.harmonicKey) {
      const compatible = camelotCompatible(fnBusContext.harmonicKey)
      result = result.filter((t) => t.key && compatible.includes(t.key.toUpperCase()))
    }
    if (fnBus.has('range') && fnBusContext.bpmRef != null) {
      const ref = fnBusContext.bpmRef
      result = result.filter((t) => t.bpm != null && Math.abs(t.bpm - ref) <= ref * 0.04)
    }
    if (fnBus.has('rating'))   result = result.filter((t) => t.rating >= 4)
    if (fnBus.has('unplayed')) result = result.filter((t) => t.playCount === 0)
    if (fnBus.has('new')) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      result = result.filter((t) => t.dateAdded && new Date(t.dateAdded).getTime() >= cutoff)
    }
    if (fnBus.has('energy'))   result = result.filter((t) => t.energy != null && t.energy >= 7)
    if (fnBus.has('analysed')) result = result.filter((t) => t.bpm != null && !!t.key)
    if (fnBus.has('cued'))     result = result.filter((t) => t.cuePoints.some((c) => c.type === 'hotcue'))
    if (fnBus.has('mood') && fnBusContext.moodRef != null) {
      const ref = fnBusContext.moodRef
      // ±0.4 window: same mood zone (1.5 span covers one full category boundary either side)
      result = result.filter((t) => t.mood != null && Math.abs(t.mood - ref) <= 0.4)
    }

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
