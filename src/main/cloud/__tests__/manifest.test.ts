import { describe, it, expect } from 'vitest'
import {
  emptyManifest,
  planPublish,
  applyUploads,
  uploadBytes,
  type CloudManifest,
  type LocalAudio
} from '../manifest'

const local = (trackId: string, cacheKey: string, size = 100, hasProxy = true): LocalAudio => ({
  trackId,
  cacheKey,
  size,
  hasProxy
})

describe('planPublish', () => {
  it('uploads everything against an empty manifest', () => {
    const plan = planPublish([local('a', 'h1'), local('b', 'h2')], emptyManifest())
    expect(plan.toUpload.map((u) => u.trackId)).toEqual(['a', 'b'])
    expect(plan.toDeleteFileIds).toEqual([])
    expect(plan.unchanged).toEqual([])
  })

  it('skips unchanged tracks and re-uploads changed content (deleting the stale file)', () => {
    const m: CloudManifest = {
      v: 1,
      publishedAt: 't',
      libraryFileId: 'lib',
      audio: {
        a: { cacheKey: 'h1', fileId: 'fa', size: 100 },
        b: { cacheKey: 'h2', fileId: 'fb', size: 100 }
      }
    }
    // a unchanged; b's content hash changed → re-upload + delete old fb.
    const plan = planPublish([local('a', 'h1'), local('b', 'h2-new')], m)
    expect(plan.unchanged).toEqual(['a'])
    expect(plan.toUpload.map((u) => u.trackId)).toEqual(['b'])
    expect(plan.toDeleteFileIds).toEqual(['fb'])
  })

  it('deletes proxies for tracks dropped from the library', () => {
    const m: CloudManifest = {
      v: 1,
      publishedAt: 't',
      libraryFileId: null,
      audio: { gone: { cacheKey: 'h', fileId: 'fg', size: 50 } }
    }
    const plan = planPublish([local('a', 'h1')], m)
    expect(plan.toUpload.map((u) => u.trackId)).toEqual(['a'])
    expect(plan.toDeleteFileIds).toEqual(['fg'])
  })

  it('reports tracks with no proxy yet instead of uploading them', () => {
    const plan = planPublish([local('a', 'h1', 100, false)], emptyManifest())
    expect(plan.toUpload).toEqual([])
    expect(plan.missingProxy).toEqual(['a'])
  })
})

describe('applyUploads', () => {
  it('folds uploads + removals + library id into a new manifest', () => {
    const m = emptyManifest()
    const next = applyUploads(
      m,
      [{ trackId: 'a', cacheKey: 'h1', fileId: 'fa', size: 100 }],
      [],
      'lib1',
      '2026-06-17T00:00:00Z'
    )
    expect(next.audio.a).toEqual({ cacheKey: 'h1', fileId: 'fa', size: 100 })
    expect(next.libraryFileId).toBe('lib1')
    expect(next.publishedAt).toBe('2026-06-17T00:00:00Z')
  })

  it('keeps the previous library id when none is supplied, and drops removed tracks', () => {
    const m: CloudManifest = {
      v: 1,
      publishedAt: 't',
      libraryFileId: 'libOld',
      audio: { a: { cacheKey: 'h1', fileId: 'fa', size: 100 } }
    }
    const next = applyUploads(m, [], ['a'], null, 'later')
    expect(next.audio.a).toBeUndefined()
    expect(next.libraryFileId).toBe('libOld')
  })

  it('retains entries for tracks that were not in this upload batch (failed/queued)', () => {
    const m: CloudManifest = {
      v: 1,
      publishedAt: 't',
      libraryFileId: null,
      audio: { a: { cacheKey: 'h1', fileId: 'fa', size: 100 } }
    }
    const next = applyUploads(m, [{ trackId: 'b', cacheKey: 'h2', fileId: 'fb', size: 100 }], [], null, 'x')
    expect(Object.keys(next.audio).sort()).toEqual(['a', 'b'])
  })
})

describe('uploadBytes', () => {
  it('sums the upload sizes', () => {
    const plan = planPublish([local('a', 'h1', 300), local('b', 'h2', 700)], emptyManifest())
    expect(uploadBytes(plan)).toBe(1000)
  })
})
