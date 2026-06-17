// Pull the desktop library into memory, backed by an on-disk snapshot (slice 5):
// the cached snapshot loads instantly on launch (and is all you get offline),
// then a live /sync/pull refreshes and re-caches it when the desktop is reachable.

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadSnapshot, saveSnapshot, loadQueue, type QueueState } from './offline'
import { patchAsTrackFields } from './edits'
import type { SyncClient } from './syncClient'
import type { Playlist, SyncPull, Track } from './sync-types'

/** A full Playlist built from a queued create/patch (for offline replay). */
function playlistFromPatch(prev: Playlist | undefined, p: QueueState['playlists'][number]): Playlist {
  const base: Playlist =
    prev ??
    {
      id: p.id,
      name: 'Playlist',
      color: '#8A8474',
      isFolder: false,
      isSmart: false,
      isAutoGroup: false,
      rules: [],
      parentId: null,
      sortOrder: 0,
      trackIds: [],
      sourceIds: {}
    }
  return {
    ...base,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.color !== undefined ? { color: p.color } : {}),
    ...(p.trackIds !== undefined ? { trackIds: p.trackIds } : {})
  }
}

export interface LibraryState {
  loading: boolean
  error: string | null
  tracks: Track[]
  playlists: Playlist[]
  byId: Map<string, Track>
  refresh: () => Promise<void>
  /** Merge fields into a track in memory (after a successful push) so the list
   *  reflects the edit without a full re-pull. */
  patchTrack: (id: string, fields: Partial<Track>) => void
  /** Insert or replace a playlist in memory (create / rename / reorder). */
  upsertPlaylist: (p: Playlist) => void
  /** Drop a playlist from memory (delete). */
  removePlaylist: (id: string) => void
}

export function useLibrary(client: SyncClient): LibraryState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [byId, setById] = useState<Map<string, Track>>(new Map())
  const hasData = useRef(false)

  const apply = useCallback((snap: SyncPull): void => {
    setTracks(snap.tracks)
    setPlaylists(snap.playlists)
    setById(new Map(snap.tracks.map((t) => [t.id, t])))
    hasData.current = true
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const snap = await client.pull(0) // full snapshot
      apply(snap)
      void saveSnapshot(snap) // cache for offline / next launch
    } catch (e) {
      // Offline (or desktop down): keep whatever cached data we already have;
      // only surface an error when we have nothing to show.
      if (!hasData.current) setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [client, apply])

  const patchTrack = useCallback((id: string, fields: Partial<Track>): void => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...fields } : t)))
    setById((prev) => {
      const cur = prev.get(id)
      if (!cur) return prev
      const next = new Map(prev)
      next.set(id, { ...cur, ...fields })
      return next
    })
  }, [])

  const upsertPlaylist = useCallback((p: Playlist): void => {
    setPlaylists((prev) => {
      const i = prev.findIndex((x) => x.id === p.id)
      if (i === -1) return [...prev, p]
      const next = prev.slice()
      next[i] = p
      return next
    })
  }, [])

  const removePlaylist = useCallback((id: string): void => {
    setPlaylists((prev) => prev.filter((p) => p.id !== id))
  }, [])

  // Replay queued offline edits over the in-memory mirror, so edits made offline
  // are still visible after a cold start (they live in the queue until flushed).
  const applyQueue = useCallback((q: QueueState): void => {
    if (q.tracks.length) {
      const fieldsById = new Map(q.tracks.map((p) => [p.id, patchAsTrackFields(p)]))
      setTracks((prev) => prev.map((t) => (fieldsById.has(t.id) ? { ...t, ...fieldsById.get(t.id) } : t)))
      setById((prev) => {
        const next = new Map(prev)
        for (const [id, fields] of fieldsById) {
          const cur = next.get(id)
          if (cur) next.set(id, { ...cur, ...fields })
        }
        return next
      })
    }
    if (q.playlists.length) {
      setPlaylists((prev) => {
        const next = prev.slice()
        for (const pp of q.playlists) {
          const i = next.findIndex((x) => x.id === pp.id)
          if (pp.deleted) {
            if (i !== -1) next.splice(i, 1)
          } else if (i !== -1) {
            next[i] = playlistFromPatch(next[i], pp)
          } else {
            next.push(playlistFromPatch(undefined, pp))
          }
        }
        return next
      })
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const cached = await loadSnapshot()
      if (cached) {
        apply(cached) // instant paint from disk
        const queued = await loadQueue()
        applyQueue(queued) // show offline edits that haven't synced yet
        setLoading(false)
      }
      await refresh() // then go to the network
    })()
  }, [refresh, apply, applyQueue])

  return { loading, error, tracks, playlists, byId, refresh, patchTrack, upsertPlaylist, removePlaylist }
}
