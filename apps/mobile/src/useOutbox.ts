// Offline-aware push + edit queue (slice 5).
//
// push() tries the desktop; on a network failure it queues the patch to disk and
// reports it as "queued" (the optimistic local change stays). A health poll
// detects reconnection and flushes the backlog. Auth failures bubble up so the
// app can re-pair.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadQueue,
  saveQueue,
  clearQueue,
  mergeTrackPatch,
  mergePlaylistPatch,
  queueCount,
  type QueueState
} from './offline'
import { UnauthorizedError, type SyncClient } from './syncClient'
import type { SyncPushPayload, SyncPushResult } from './sync-types'

export interface Outbox {
  online: boolean
  pending: number
  flushing: boolean
  /** Send now, or queue if offline. Resolves to the desktop result, or null when queued. */
  push: (payload: SyncPushPayload) => Promise<SyncPushResult | null>
  /** Try to drain the queue (called automatically on reconnect; also manual). */
  flush: () => Promise<void>
}

export function useOutbox(client: SyncClient, onUnauthorized: () => void): Outbox {
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState(0)
  const [flushing, setFlushing] = useState(false)
  const queueRef = useRef<QueueState>({ tracks: [], playlists: [] })

  const setQueue = useCallback(async (q: QueueState): Promise<void> => {
    queueRef.current = q
    setPending(queueCount(q))
    await saveQueue(q)
  }, [])

  useEffect(() => {
    void (async () => {
      const q = await loadQueue()
      queueRef.current = q
      setPending(queueCount(q))
    })()
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    const q = queueRef.current
    if (queueCount(q) === 0) return
    setFlushing(true)
    try {
      await client.push({ tracks: q.tracks, playlists: q.playlists })
      queueRef.current = { tracks: [], playlists: [] }
      await clearQueue()
      setPending(0)
      setOnline(true)
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setOnline(false) // still unreachable — keep the queue for next time
    } finally {
      setFlushing(false)
    }
  }, [client, onUnauthorized])

  const enqueue = useCallback(
    async (payload: SyncPushPayload): Promise<void> => {
      let q = queueRef.current
      for (const t of payload.tracks ?? []) q = mergeTrackPatch(q, t)
      for (const p of payload.playlists ?? []) q = mergePlaylistPatch(q, p)
      await setQueue(q)
    },
    [setQueue]
  )

  const push = useCallback(
    async (payload: SyncPushPayload): Promise<SyncPushResult | null> => {
      try {
        if (queueCount(queueRef.current) > 0) await flush() // drain backlog first
        const res = await client.push(payload)
        setOnline(true)
        return res
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          onUnauthorized()
          throw e
        }
        await enqueue(payload) // network failure → queue, keep optimistic local
        setOnline(false)
        return null
      }
    },
    [client, flush, enqueue, onUnauthorized]
  )

  // Reconnection detector: poll /health; on success, flush any backlog.
  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        await client.health(4000)
        if (cancelled) return
        setOnline(true)
        if (queueCount(queueRef.current) > 0) await flush()
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    const iv = setInterval(() => void tick(), 12000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [client, flush])

  return { online, pending, flushing, push, flush }
}
