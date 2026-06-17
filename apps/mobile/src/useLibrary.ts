// Pull the desktop library into memory (slice 2: read-only mirror). Offline
// disk caching + delta cursors are slice 5 — this just does a full /sync/pull.

import { useCallback, useEffect, useState } from 'react'
import type { SyncClient } from './syncClient'
import type { Playlist, Track } from './sync-types'

export interface LibraryState {
  loading: boolean
  error: string | null
  tracks: Track[]
  playlists: Playlist[]
  byId: Map<string, Track>
  refresh: () => Promise<void>
}

export function useLibrary(client: SyncClient): LibraryState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [byId, setById] = useState<Map<string, Track>>(new Map())

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const snap = await client.pull(0) // full snapshot
      setTracks(snap.tracks)
      setPlaylists(snap.playlists)
      setById(new Map(snap.tracks.map((t) => [t.id, t])))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { loading, error, tracks, playlists, byId, refresh }
}
