/**
 * useTrackMenu — one shared right-click menu for tracks, usable on any page.
 *
 * The Library page used to own a ~100-line inline context-menu block; every
 * other page (Orders, Set Builder, Search, Compass, Health…) had none. This
 * hook builds that menu once — preview, load A/B, playlists, analysis, reveal,
 * delete — and exposes a tiny API:
 *
 *   const { openTrackMenu, trackMenu } = useTrackMenu()
 *   ...
 *   onContextMenu={(e) => openTrackMenu(e, { ids, track })}
 *   ...
 *   {trackMenu}
 *
 * Pages may inject page-specific items (e.g. "Remove from running order") via
 * `remove` / `extraSections` without re-implementing the common actions.
 */

import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { Track } from '@shared/types'
import { ContextMenu, type ContextSection } from '../components/ContextMenu'
import { useLibraryStore } from '../store/libraryStore'
import { useDeckAStore, useDeckBStore } from '../store/playerStore'
import { useAnalysisStore } from '../store/analysisStore'
import { usePreview } from './usePreview'

export interface OpenTrackMenuOpts {
  /** Tracks the menu acts on. If empty, falls back to [track.id]. */
  ids: string[]
  /** The right-clicked (primary) track — drives single-track actions. */
  track: Track | null
  /** When set, shows a "Remove from playlist" item bound to this playlist. */
  playlistId?: string | null
  /** Custom removal (e.g. running-order entry); overrides the playlist remove. */
  remove?: { label: string; action: () => void }
  /** Optional "Open details" / edit-metadata callback. */
  onShowDetail?: (track: Track) => void
  /** Page-specific sections appended after the common ones. */
  extraSections?: ContextSection[]
}

interface MenuState extends OpenTrackMenuOpts {
  x: number
  y: number
}

export function useTrackMenu(): {
  openTrackMenu: (e: React.MouseEvent, opts: OpenTrackMenuOpts) => void
  closeTrackMenu: () => void
  trackMenu: JSX.Element | null
} {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const playlists = useLibraryStore((s) => s.playlists)
  const addTracksToPlaylist = useLibraryStore((s) => s.addTracksToPlaylist)
  const deleteTracks = useLibraryStore((s) => s.deleteTracks)
  const loadTrackA = useDeckAStore((s) => s.loadTrack)
  const loadTrackB = useDeckBStore((s) => s.loadTrack)
  const { previewId, toggle: previewToggle } = usePreview()

  const analyseBpm = useAnalysisStore((s) => s.analyseBpm)
  const analyseEnergy = useAnalysisStore((s) => s.analyseEnergy)
  const analyseBeats = useAnalysisStore((s) => s.analyseBeats)
  const autoCue = useAnalysisStore((s) => s.autoCue)
  const analyseAll = useAnalysisStore((s) => s.analyseAll)
  const writeTags = useAnalysisStore((s) => s.writeTags)

  const openTrackMenu = useCallback((e: React.MouseEvent, opts: OpenTrackMenuOpts) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ ...opts, x: e.clientX, y: e.clientY })
  }, [])

  const closeTrackMenu = useCallback(() => setMenu(null), [])

  let trackMenu: JSX.Element | null = null
  if (menu) {
    const ids = menu.ids.length > 0 ? menu.ids : menu.track ? [menu.track.id] : []
    const track = menu.track
    const isMulti = ids.length > 1
    const n = ids.length
    const nonSmartPlaylists = playlists.filter((p) => !p.isSmart && !p.isFolder)

    const sections: ContextSection[] = [
      {
        items: [
          {
            label: previewId === track?.id ? '■ stop preview' : '▶ preview 30s',
            disabled: isMulti || !track,
            action: () => track && previewToggle(track)
          },
          {
            label: 'Load to Deck A',
            shortcut: '↵',
            disabled: isMulti || !track,
            action: () => track && loadTrackA(track)
          },
          {
            label: 'Load to Deck B',
            shortcut: '⇧↵',
            disabled: isMulti || !track,
            action: () => track && loadTrackB(track)
          }
        ]
      },
      {
        items: [
          {
            label: 'Add to playlist',
            disabled: nonSmartPlaylists.length === 0,
            submenu: nonSmartPlaylists.map((pl) => ({
              label: pl.name,
              action: () => addTracksToPlaylist(pl.id, ids)
            }))
          },
          {
            label: 'Create playlist from selection',
            action: async () => {
              const name = window.prompt('New playlist name:', track?.artist || 'New Playlist')
              if (!name?.trim()) return
              const { createPlaylist, addTracksToPlaylist: atp } = useLibraryStore.getState()
              const newPl = await createPlaylist(name.trim())
              await atp(newPl.id, ids)
            }
          },
          ...(menu.remove
            ? [{ label: menu.remove.label, action: menu.remove.action }]
            : menu.playlistId && !playlists.find((p) => p.id === menu.playlistId)?.isSmart
              ? [{
                  label: 'Remove from playlist',
                  action: () => window.api.library.removeTracksFromPlaylist(menu.playlistId!, ids)
                    .then(() => useLibraryStore.getState().loadLibrary())
                }]
              : [])
        ]
      },
      {
        items: [
          { label: isMulti ? `Analyse all (${n})` : 'Analyse all', action: () => analyseAll(ids) },
          { label: isMulti ? `Analyse BPM + key (${n})` : 'Analyse BPM + key', action: () => analyseBpm(ids) },
          { label: isMulti ? `Analyse energy (${n})` : 'Analyse energy', action: () => analyseEnergy(ids) },
          { label: isMulti ? `Detect beat grid (${n})` : 'Detect beat grid', action: () => analyseBeats(ids) },
          { label: isMulti ? `Auto-cue (${n})` : 'Auto-cue', action: () => autoCue(ids) },
          { label: isMulti ? `Write tags to file (${n})` : 'Write tags to file', action: () => writeTags(ids) }
        ]
      },
      ...(menu.onShowDetail
        ? [{ items: [{
            label: 'Open details',
            disabled: isMulti || !track,
            action: () => track && menu.onShowDetail!(track)
          }] }]
        : []),
      ...(menu.extraSections ?? []),
      {
        items: [
          {
            label: 'Open in Finder',
            disabled: isMulti || !track,
            action: () => track && window.api.settings.openInFinder(track.filePath)
          }
        ]
      },
      {
        items: [
          {
            label: isMulti ? `Delete ${n} tracks` : 'Delete from library',
            danger: true,
            action: async () => {
              const label = isMulti ? `${n} tracks` : `"${track?.title || 'this track'}"`
              if (!window.confirm(`Remove ${label} from library?`)) return
              await deleteTracks(ids)
            }
          }
        ]
      }
    ]

    trackMenu = (
      <ContextMenu x={menu.x} y={menu.y} onClose={closeTrackMenu} sections={sections} />
    )
  }

  return { openTrackMenu, closeTrackMenu, trackMenu }
}

// ── Global provider ───────────────────────────────────────────────────────────
// Mount <TrackMenuProvider> once near the app root so any component — including
// deeply-nested track rows — can call `useTrackMenuContext()(e, opts)` without
// threading an onContextMenu prop down, and a single menu renders for all pages.

type OpenTrackMenu = (e: React.MouseEvent, opts: OpenTrackMenuOpts) => void

const TrackMenuContext = createContext<OpenTrackMenu | null>(null)

export function TrackMenuProvider({ children }: { children: ReactNode }): JSX.Element {
  const { openTrackMenu, trackMenu } = useTrackMenu()
  return (
    <TrackMenuContext.Provider value={openTrackMenu}>
      {children}
      {trackMenu}
    </TrackMenuContext.Provider>
  )
}

/** Returns the shared `openTrackMenu(e, opts)` from the nearest provider. */
export function useTrackMenuContext(): OpenTrackMenu {
  const ctx = useContext(TrackMenuContext)
  if (!ctx) throw new Error('useTrackMenuContext must be used within <TrackMenuProvider>')
  return ctx
}
