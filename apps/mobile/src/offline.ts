// On-device persistence for slice 5 (offline). Everything lives under a single
// app-documents folder:
//   snapshot.json          last successful /sync/pull — instant + offline open
//   queue.json             prep/playlist edits made while offline, flushed later
//   peaks/<id>.json        cached waveform bands
//   audio/<id>.m4a         tracks the user explicitly saved for offline audition
//
// We use the legacy expo-file-system API (stable read/write/download helpers).

import * as FS from 'expo-file-system/legacy'
import type { PeaksData, SyncPull, TrackPatch, PlaylistPatch } from './sync-types'

const ROOT = (FS.documentDirectory ?? '') + 'offcut/'
const SNAPSHOT = ROOT + 'snapshot.json'
const QUEUE = ROOT + 'queue.json'
const PEAKS_DIR = ROOT + 'peaks/'
const AUDIO_DIR = ROOT + 'audio/' // explicit "save for offline" (persistent, user-curated)
const PLAY_DIR = ROOT + 'playcache/' // transient auto-cache so audition seeks/loops are local & snappy

/** Cap on offline-saved audio files (oldest evicted). Each AAC proxy is a few MB. */
const AUDIO_LRU = 40
/** Cap on the transient playback cache. */
const PLAY_LRU = 30

/** Filesystem-safe key for an arbitrary track id. */
function key(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FS.getInfoAsync(dir)
  if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true })
}

async function readJson<T>(uri: string): Promise<T | null> {
  try {
    const info = await FS.getInfoAsync(uri)
    if (!info.exists) return null
    return JSON.parse(await FS.readAsStringAsync(uri)) as T
  } catch {
    return null
  }
}

async function writeJson(uri: string, value: unknown): Promise<void> {
  await ensureDir(ROOT)
  await FS.writeAsStringAsync(uri, JSON.stringify(value))
}

// ── Library snapshot ────────────────────────────────────────────────────────

export function saveSnapshot(pull: SyncPull): Promise<void> {
  return writeJson(SNAPSHOT, pull)
}
export function loadSnapshot(): Promise<SyncPull | null> {
  return readJson<SyncPull>(SNAPSHOT)
}

// ── Peaks cache ───────────────────────────────────────────────────────────────

export async function getCachedPeaks(trackId: string): Promise<PeaksData | null> {
  return readJson<PeaksData>(PEAKS_DIR + key(trackId) + '.json')
}
export async function cachePeaks(trackId: string, data: PeaksData): Promise<void> {
  await ensureDir(PEAKS_DIR)
  await FS.writeAsStringAsync(PEAKS_DIR + key(trackId) + '.json', JSON.stringify(data))
}

// ── Audio cache (explicit "save for offline") ─────────────────────────────────

function audioUri(trackId: string): string {
  return AUDIO_DIR + key(trackId) + '.m4a'
}

/** Local file uri if this track's audio is saved offline, else null. */
export async function cachedAudioUri(trackId: string): Promise<string | null> {
  const uri = audioUri(trackId)
  const info = await FS.getInfoAsync(uri)
  return info.exists ? uri : null
}

/** Download the proxy to disk for offline audition; returns the local uri. */
export async function saveAudioOffline(trackId: string, remoteUrl: string): Promise<string> {
  await ensureDir(AUDIO_DIR)
  const uri = audioUri(trackId)
  await FS.downloadAsync(remoteUrl, uri)
  await evictDir(AUDIO_DIR, AUDIO_LRU)
  return uri
}

export async function removeAudioOffline(trackId: string): Promise<void> {
  await FS.deleteAsync(audioUri(trackId), { idempotent: true })
}

// ── Transient playback cache ──────────────────────────────────────────────────
// Auto-caching the proxy to a local file on load makes seeks/loops/cue-jumps
// near-instant (no LAN re-buffering on every seek). LRU-bounded; not user-curated.

function playUri(trackId: string): string {
  return PLAY_DIR + key(trackId) + '.m4a'
}

/** Local uri if this track is already in the playback cache, else null. */
export async function playbackCachedUri(trackId: string): Promise<string | null> {
  const uri = playUri(trackId)
  return (await FS.getInfoAsync(uri)).exists ? uri : null
}

/** Ensure the proxy is cached locally for snappy audition; returns the local uri. */
export async function ensurePlaybackCache(trackId: string, remoteUrl: string): Promise<string> {
  const uri = playUri(trackId)
  if ((await FS.getInfoAsync(uri)).exists) return uri
  await ensureDir(PLAY_DIR)
  await FS.downloadAsync(remoteUrl, uri)
  await evictDir(PLAY_DIR, PLAY_LRU)
  return uri
}

/** Evict oldest files in `dir` beyond `keep` (best-effort LRU by mtime). */
async function evictDir(dir: string, keep: number): Promise<void> {
  try {
    const names = await FS.readDirectoryAsync(dir)
    if (names.length <= keep) return
    const stamped = await Promise.all(
      names.map(async (n) => {
        const info = await FS.getInfoAsync(dir + n)
        return { n, t: info.exists ? info.modificationTime ?? 0 : 0 }
      })
    )
    stamped.sort((a, b) => a.t - b.t) // oldest first
    for (const { n } of stamped.slice(0, stamped.length - keep)) {
      await FS.deleteAsync(dir + n, { idempotent: true })
    }
  } catch {
    /* eviction is best-effort */
  }
}

/** Count + byte size of offline-saved audio, for a "manage storage" readout. */
export async function audioCacheStats(): Promise<{ count: number; bytes: number }> {
  try {
    const names = await FS.readDirectoryAsync(AUDIO_DIR)
    let bytes = 0
    for (const n of names) {
      const info = await FS.getInfoAsync(AUDIO_DIR + n)
      if (info.exists && !info.isDirectory) bytes += info.size ?? 0
    }
    return { count: names.length, bytes }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

export async function clearAudioCache(): Promise<void> {
  await FS.deleteAsync(AUDIO_DIR, { idempotent: true })
  await FS.deleteAsync(PLAY_DIR, { idempotent: true })
}

// ── Outbound edit queue ───────────────────────────────────────────────────────
//
// Edits made offline accumulate here, merged by id so repeated edits collapse to
// one patch (last value wins, newest updatedAt). Flushed as a single push.

export interface QueueState {
  tracks: TrackPatch[]
  playlists: PlaylistPatch[]
}

const EMPTY_QUEUE: QueueState = { tracks: [], playlists: [] }

export async function loadQueue(): Promise<QueueState> {
  return (await readJson<QueueState>(QUEUE)) ?? { ...EMPTY_QUEUE }
}
export function saveQueue(q: QueueState): Promise<void> {
  return writeJson(QUEUE, q)
}
export function clearQueue(): Promise<void> {
  return writeJson(QUEUE, EMPTY_QUEUE)
}

/** Merge a track patch into the queue (field-wise, keeping the newest values). */
export function mergeTrackPatch(q: QueueState, patch: TrackPatch): QueueState {
  const i = q.tracks.findIndex((t) => t.id === patch.id)
  const tracks = q.tracks.slice()
  if (i === -1) tracks.push(patch)
  else tracks[i] = { ...tracks[i], ...patch }
  return { ...q, tracks }
}

/** Merge a playlist patch into the queue (a delete supersedes prior field edits). */
export function mergePlaylistPatch(q: QueueState, patch: PlaylistPatch): QueueState {
  const i = q.playlists.findIndex((p) => p.id === patch.id)
  const playlists = q.playlists.slice()
  if (i === -1) playlists.push(patch)
  else playlists[i] = patch.deleted ? patch : { ...playlists[i], ...patch }
  return { ...q, playlists }
}

export function queueCount(q: QueueState): number {
  return q.tracks.length + q.playlists.length
}
