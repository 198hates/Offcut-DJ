// Google Drive publish manifest + change detection (Phase A core).
//
// The desktop mirrors the library to a private Drive folder so the phone can
// read it from anywhere with internet. A track's audio is keyed by its
// proxyCacheKey (content hash), so when the audio changes the key changes and we
// re-upload exactly that file. The manifest records, per track, which Drive file
// holds its current proxy — both to drive incremental uploads and so the phone
// can resolve trackId → Drive fileId for download.
//
// This module is pure (no Drive/IO) so the diff is unit-testable; the Drive
// transport + OAuth live alongside it and inject results.

/** A track's proxy as published to Drive. */
export interface PublishedAudio {
  cacheKey: string // proxyCacheKey at upload time — changes ⇒ re-upload
  fileId: string // Drive file id
  size: number
}

export interface CloudManifest {
  v: 1
  publishedAt: string // ISO
  /** Drive file id of the uploaded library.json snapshot, or null if none yet. */
  libraryFileId: string | null
  /** trackId → its published proxy. */
  audio: Record<string, PublishedAudio>
}

export function emptyManifest(): CloudManifest {
  return { v: 1, publishedAt: '', libraryFileId: null, audio: {} }
}

/** What the desktop currently wants published, per track. */
export interface LocalAudio {
  trackId: string
  cacheKey: string
  size: number
  /** False when the proxy hasn't been generated yet (skip — can't upload it). */
  hasProxy: boolean
}

export interface PublishPlan {
  /** Proxies to upload (new tracks or changed content). */
  toUpload: LocalAudio[]
  /** Drive file ids to delete (track removed, or superseded by a new cacheKey). */
  toDeleteFileIds: string[]
  /** Tracks already published at the current cacheKey — nothing to do. */
  unchanged: string[]
  /** Tracks wanted but with no proxy yet (reported so the UI can prompt a build). */
  missingProxy: string[]
}

/**
 * Diff the desktop's desired audio set against what's already on Drive.
 * Pure — the caller performs the uploads/deletes and folds the results into a
 * new manifest with {@link applyUploads}.
 */
export function planPublish(local: LocalAudio[], manifest: CloudManifest): PublishPlan {
  const plan: PublishPlan = { toUpload: [], toDeleteFileIds: [], unchanged: [], missingProxy: [] }
  const wanted = new Set<string>()

  for (const item of local) {
    wanted.add(item.trackId)
    if (!item.hasProxy) {
      plan.missingProxy.push(item.trackId)
      continue
    }
    const published = manifest.audio[item.trackId]
    if (!published) {
      plan.toUpload.push(item)
    } else if (published.cacheKey !== item.cacheKey) {
      // Content changed: upload the new proxy and delete the stale Drive file.
      plan.toUpload.push(item)
      plan.toDeleteFileIds.push(published.fileId)
    } else {
      plan.unchanged.push(item.trackId)
    }
  }

  // Tracks dropped from the library: delete their Drive proxies.
  for (const [trackId, published] of Object.entries(manifest.audio)) {
    if (!wanted.has(trackId)) plan.toDeleteFileIds.push(published.fileId)
  }

  return plan
}

/** Result of one upload the transport performed. */
export interface UploadResult {
  trackId: string
  cacheKey: string
  fileId: string
  size: number
}

/**
 * Fold successful uploads/deletes + a fresh library file id into a new manifest.
 * Tracks no longer wanted are dropped; failed uploads (absent from `uploaded`)
 * keep their previous entry so a later publish retries them.
 */
export function applyUploads(
  manifest: CloudManifest,
  uploaded: UploadResult[],
  removedTrackIds: string[],
  libraryFileId: string | null,
  publishedAt: string
): CloudManifest {
  const audio: Record<string, PublishedAudio> = { ...manifest.audio }
  for (const id of removedTrackIds) delete audio[id]
  for (const u of uploaded) audio[u.trackId] = { cacheKey: u.cacheKey, fileId: u.fileId, size: u.size }
  return {
    v: 1,
    publishedAt,
    libraryFileId: libraryFileId ?? manifest.libraryFileId,
    audio
  }
}

/** Total bytes the plan will upload — for a pre-publish size estimate. */
export function uploadBytes(plan: PublishPlan): number {
  return plan.toUpload.reduce((n, u) => n + u.size, 0)
}
