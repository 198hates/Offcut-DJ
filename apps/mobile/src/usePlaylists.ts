// Playlist mutations (slice 4): optimistic local update → POST /sync/push →
// roll back on network failure or a last-writer-wins rejection. Actions throw a
// human-readable Error the screens surface.

import { useMemo } from 'react'
import { newLocalPlaylist, withTrack } from './playlists'
import type { SyncClient } from './syncClient'
import type { LibraryState } from './useLibrary'
import type { Playlist } from './sync-types'

const STALE = 'Desktop has newer changes — pull to refresh.'

/** The fields of a playlist the phone may change in one patch. */
export interface PlaylistEdit {
  name?: string
  color?: string
  trackIds?: string[]
}

export interface PlaylistActions {
  create: (name: string) => Promise<Playlist>
  update: (p: Playlist, edit: PlaylistEdit) => Promise<void>
  remove: (p: Playlist) => Promise<void>
  addTrack: (p: Playlist, trackId: string) => Promise<void>
}

export function usePlaylistActions(client: SyncClient, lib: LibraryState): PlaylistActions {
  return useMemo<PlaylistActions>(() => {
    const now = (): string => new Date().toISOString()

    const create = async (name: string): Promise<Playlist> => {
      const p = newLocalPlaylist(name)
      lib.upsertPlaylist(p) // optimistic
      try {
        await client.push({
          playlists: [{ id: p.id, updatedAt: now(), name: p.name, color: p.color, trackIds: [] }]
        })
        return p
      } catch (e) {
        lib.removePlaylist(p.id) // roll back
        throw e
      }
    }

    const update = async (p: Playlist, edit: PlaylistEdit): Promise<void> => {
      lib.upsertPlaylist({ ...p, ...edit }) // optimistic
      try {
        const res = await client.push({ playlists: [{ id: p.id, updatedAt: now(), ...edit }] })
        if (res.appliedPlaylists === 0) {
          lib.upsertPlaylist(p)
          throw new Error(STALE)
        }
      } catch (e) {
        lib.upsertPlaylist(p) // roll back
        throw e
      }
    }

    const remove = async (p: Playlist): Promise<void> => {
      lib.removePlaylist(p.id) // optimistic
      try {
        const res = await client.push({ playlists: [{ id: p.id, updatedAt: now(), deleted: true }] })
        if (res.appliedPlaylists === 0) {
          lib.upsertPlaylist(p)
          throw new Error(STALE)
        }
      } catch (e) {
        lib.upsertPlaylist(p) // roll back
        throw e
      }
    }

    const addTrack = (p: Playlist, trackId: string): Promise<void> =>
      update(p, { trackIds: withTrack(p.trackIds, trackId) })

    return { create, update, remove, addTrack }
  }, [client, lib])
}
