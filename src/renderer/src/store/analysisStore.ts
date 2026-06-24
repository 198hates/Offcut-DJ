/**
 * analysisStore — page-independent track analysis runner.
 *
 * The BPM/key, energy, beat-grid and auto-cue routines used to live inside the
 * Library page, so only Library could trigger them. They now live here so the
 * right-click menu on *any* page (Orders, Set Builder, Search, Health…)
 * can run them, with a single shared progress bar rendered globally in App.
 *
 * All reads go through `useLibraryStore.getState()` so there is no dependency on
 * a page-level `tracks` array.
 */

import { create } from 'zustand'
import type { Track } from '@shared/types'
import { useLibraryStore } from './libraryStore'
import { useToastStore } from './toastStore'
import { analyzeAudio, decodeTrackToBuffer, downbeatsForTrack, suggestedCuesToCuePoints } from '../lib/analyzer'
import { fromBeatgridMarkers } from '../lib/quantiser'
import { withPhraseCues } from '../lib/phraseDetect'
import { mapPool, resolveConcurrency } from '../lib/concurrency'
import { resolveCueTemplate, applyCueTemplate, templateThresholdScale } from '../lib/cueTemplates'
import type { CueTemplate } from '@shared/types'

/** Resolve the user's analysis-concurrency setting (0 = auto) for this run. */
async function concurrency(): Promise<number> {
  try { return resolveConcurrency((await window.api.settings.get()).analysisConcurrency) }
  catch { return resolveConcurrency(undefined) }
}

/** The active auto-cue template (falls back to the Standard preset). */
async function activeCueTemplate(): Promise<CueTemplate> {
  try { return resolveCueTemplate(await window.api.settings.get()) }
  catch { return resolveCueTemplate(null) }
}
import { generateBeatgrid } from '../lib/compatibility'

export interface AnalysisProgress {
  label: string
  current: number
  total: number
  track: string
}

interface AnalysisState {
  progress: AnalysisProgress | null
  /** True while any run is active (prevents overlapping runs). */
  running: boolean
  /** Set by cancel(); checked by the runner loops to stop early. */
  cancelled: boolean
  /** Request the active run to stop after its in-flight tracks finish. */
  cancel: () => void
  analyseBpm: (ids: string[]) => Promise<void>
  analyseEnergy: (ids: string[]) => Promise<void>
  analyseBeats: (ids: string[]) => Promise<void>
  autoCue: (ids: string[]) => Promise<void>
  /** Run the full chain: beat grid → BPM/key/energy → auto-cue, in order. */
  analyseAll: (ids: string[]) => Promise<void>
  writeTags: (ids: string[]) => Promise<void>
}

const findTrack = (id: string): Track | undefined =>
  useLibraryStore.getState().tracks.find((x) => x.id === id)

const toast = (msg: string, type: 'success' | 'info' | 'error'): void =>
  useToastStore.getState().show(msg, type)

const plural = (n: number): string => (n !== 1 ? 's' : '')

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  progress: null,
  running: false,
  cancelled: false,
  cancel: () => set({ cancelled: true }),

  analyseBpm: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true, cancelled: false })
    const updateTrack = useLibraryStore.getState().updateTrack
    const ctx = new AudioContext()
    set({ progress: { label: 'BPM + key', current: 0, total: ids.length, track: '' } })
    await mapPool(ids, await concurrency(), async (id) => {
      const t = findTrack(id)
      if (!t) return
      // Phase 1: embedded tags
      try {
        const tags = await window.api.audio.readTags(t.filePath)
        if (tags) {
          const newBpm = (!t.bpm && tags.bpm) ? tags.bpm : t.bpm
          const newKey = (!t.key && tags.key) ? tags.key : t.key
          if (newBpm !== t.bpm || newKey !== t.key)
            await updateTrack({ id, bpm: newBpm, key: newKey })
        }
      } catch { /* continue */ }
      // Phase 2: audio decode (if bpm, key, OR energy still missing)
      const current = findTrack(id) ?? t
      if (!current.bpm || !current.key || current.energy == null || current.beatgrid.length === 0) {
        const buf = await decodeTrackToBuffer(t.filePath, ctx)
        const result = await analyzeAudio(buf, downbeatsForTrack(current))
        const newBpm = result.bpm ?? current.bpm
        // Never clobber an existing beatgrid: phase 2 also runs for tracks
        // that only miss key/energy, and a regenerated uniform grid would
        // silently replace a model-analysed or hand-edited one.
        const beatgrid = (current.beatgrid.length === 0 && newBpm && result.offsetMs != null)
          ? generateBeatgrid(newBpm, result.offsetMs, buf.duration * 1000)
          : current.beatgrid
        const cuePoints = (current.cuePoints.length === 0 && result.suggestedCues.length > 0)
          ? result.suggestedCues.map((c, idx) => ({
              index: idx, type: 'hotcue' as const,
              positionMs: c.positionMs, color: c.color, label: c.label, confidence: c.confidence,
            }))
          : current.cuePoints
        await updateTrack({ id, bpm: newBpm, key: result.key ?? current.key, energy: result.energy ?? current.energy, beatgrid, cuePoints })
      }
    }, { onProgress: (done) => set({ progress: { label: 'BPM + key', current: done, total: ids.length, track: '' } }), cancelled: () => get().cancelled })
    await ctx.close()
    const stopped = get().cancelled
    set({ progress: null, running: false })
    toast(stopped ? 'BPM + key analysis cancelled' : `Analysed ${ids.length} track${plural(ids.length)}`, stopped ? 'info' : 'success')
  },

  analyseEnergy: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true, cancelled: false })
    const updateTrack = useLibraryStore.getState().updateTrack
    const ctx = new AudioContext()
    set({ progress: { label: 'energy', current: 0, total: ids.length, track: '' } })
    await mapPool(ids, await concurrency(), async (id) => {
      const t = findTrack(id)
      if (!t) return
      const buf = await decodeTrackToBuffer(t.filePath, ctx)
      const result = await analyzeAudio(buf)
      const current = findTrack(id) ?? t
      const newBpm = result.bpm ?? current.bpm
      const beatgrid = (current.beatgrid.length === 0 && newBpm && result.offsetMs != null)
        ? generateBeatgrid(newBpm, result.offsetMs, buf.duration * 1000)
        : current.beatgrid
      await updateTrack({ id, energy: result.energy ?? current.energy, bpm: newBpm, key: result.key ?? current.key, beatgrid })
    }, { onProgress: (done) => set({ progress: { label: 'energy', current: done, total: ids.length, track: '' } }), cancelled: () => get().cancelled })
    await ctx.close()
    const stopped = get().cancelled
    set({ progress: null, running: false })
    toast(stopped ? 'Energy analysis cancelled' : `Energy scored for ${ids.length} track${plural(ids.length)}`, stopped ? 'info' : 'success')
  },

  analyseBeats: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true, cancelled: false })
    set({ progress: { label: 'beat grid', current: 0, total: ids.length, track: '' } })
    await mapPool(ids, await concurrency(), async (id) => {
      const updated = await window.api.library.analyzeBeats(id)
      // analyzeBeats persists only the legacy `beatgrid` markers + bpm. The grid
      // that sync / automix / quantise actually read is the v2 `analysedBeatgrid`,
      // so build it from the model's (phase-following) markers and persist it too
      // — otherwise re-analysing a track leaves the old v2 grid untouched and
      // playback never changes. Mirrors BeatThisQuantiser.analyse().
      const sorted = [...updated.beatgrid].sort((a, b) => a.positionMs - b.positionMs)
      const v2 = fromBeatgridMarkers(sorted, 'beat-this')
      await window.api.library.updateTrack({ id, analysedBeatgrid: v2 })
    }, { onProgress: (done) => set({ progress: { label: 'beat grid', current: done, total: ids.length, track: '' } }), cancelled: () => get().cancelled })
    await useLibraryStore.getState().loadLibrary()
    const stopped = get().cancelled
    set({ progress: null, running: false })
    toast(stopped ? 'Beat-grid analysis cancelled' : `Beat grid analysed for ${ids.length} track${plural(ids.length)}`, stopped ? 'info' : 'success')
  },

  autoCue: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true, cancelled: false })
    const updateTrack = useLibraryStore.getState().updateTrack
    const actx = new AudioContext()
    const template = await activeCueTemplate()
    const scale = templateThresholdScale(template)
    set({ progress: { label: 'auto-cue', current: 0, total: ids.length, track: '' } })
    await mapPool(ids, await concurrency(), async (id) => {
      const t = findTrack(id)
      if (!t) return
      const buf = await decodeTrackToBuffer(t.filePath, actx)
      const result = await analyzeAudio(buf, downbeatsForTrack(t), scale)
      const shaped = applyCueTemplate(result.suggestedCues, template)
      if (shaped.length > 0) {
        const cuePoints = withPhraseCues(suggestedCuesToCuePoints(shaped), t.phrases)
        await updateTrack({ id, cuePoints })
      }
    }, { onProgress: (done) => set({ progress: { label: 'auto-cue', current: done, total: ids.length, track: '' } }), cancelled: () => get().cancelled })
    await actx.close()
    const stopped = get().cancelled
    set({ progress: null, running: false })
    toast(stopped ? 'Auto-cue cancelled' : `Auto-cued ${ids.length} track${plural(ids.length)}`, stopped ? 'info' : 'success')
  },

  analyseAll: async (ids) => {
    if (get().running || ids.length === 0) return
    // Order matters: the beat grid runs first so its real downbeats are present
    // when BPM/key/energy and auto-cue read them (auto-cue anchors to the real
    // bars — Phase A). Each step manages the `running` flag itself, so analyseAll
    // simply awaits them in sequence rather than holding the flag across all.
    set({ cancelled: false })
    await get().analyseBeats(ids)
    if (get().cancelled) return
    await get().analyseBpm(ids)
    if (get().cancelled) return
    await get().autoCue(ids)
    if (get().cancelled) return
    toast(`Full analysis complete for ${ids.length} track${plural(ids.length)}`, 'success')
  },

  writeTags: async (ids) => {
    if (ids.length === 0) return
    if (ids.length === 1) {
      const r = await window.api.library.writeTagsToFile(ids[0])
      if (r.skipped)      toast('Format not supported for tag writing', 'info')
      else if (r.success) toast('Tags written to file', 'success')
      else                toast(`Write failed: ${r.error}`, 'error')
      return
    }
    const r = await window.api.library.writeTagsBulk(ids)
    const parts: string[] = []
    if (r.succeeded > 0) parts.push(`${r.succeeded} updated`)
    if (r.failed > 0)    parts.push(`${r.failed} failed`)
    if (r.skipped > 0)   parts.push(`${r.skipped} skipped`)
    toast(parts.join(' · ') || 'Nothing to write', r.failed > 0 ? 'error' : 'success')
  },
}))
