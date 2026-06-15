/**
 * analysisStore — page-independent track analysis runner.
 *
 * The BPM/key, energy, beat-grid and auto-cue routines used to live inside the
 * Library page, so only Library could trigger them. They now live here so the
 * right-click menu on *any* page (Orders, Set Builder, Search, Compass, Health…)
 * can run them, with a single shared progress bar rendered globally in App.
 *
 * All reads go through `useLibraryStore.getState()` so there is no dependency on
 * a page-level `tracks` array.
 */

import { create } from 'zustand'
import type { Track } from '@shared/types'
import { useLibraryStore } from './libraryStore'
import { useToastStore } from './toastStore'
import { analyzeAudio, downbeatsForTrack } from '../lib/analyzer'
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
  analyseBpm: (ids: string[]) => Promise<void>
  analyseEnergy: (ids: string[]) => Promise<void>
  analyseBeats: (ids: string[]) => Promise<void>
  autoCue: (ids: string[]) => Promise<void>
  writeTags: (ids: string[]) => Promise<void>
}

function trackLabel(t: Track): string {
  return t.title || t.artist || t.filePath.split('/').pop() || t.id
}

const findTrack = (id: string): Track | undefined =>
  useLibraryStore.getState().tracks.find((x) => x.id === id)

const toast = (msg: string, type: 'success' | 'info' | 'error'): void =>
  useToastStore.getState().show(msg, type)

const plural = (n: number): string => (n !== 1 ? 's' : '')

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  progress: null,
  running: false,

  analyseBpm: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true })
    const updateTrack = useLibraryStore.getState().updateTrack
    const ctx = new AudioContext()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = findTrack(id)
      if (!t) continue
      set({ progress: { label: 'BPM + key', current: i + 1, total: ids.length, track: trackLabel(t) } })
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
        try {
          const ab = await window.api.audio.readFile(t.filePath)
          const buf = await ctx.decodeAudioData(ab)
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
                positionMs: c.positionMs, color: c.color, label: c.label,
              }))
            : current.cuePoints
          await updateTrack({ id, bpm: newBpm, key: result.key ?? current.key, energy: result.energy ?? current.energy, beatgrid, cuePoints })
        } catch { /* unreadable */ }
      }
    }
    await ctx.close()
    set({ progress: null, running: false })
    toast(`Analysed ${ids.length} track${plural(ids.length)}`, 'success')
  },

  analyseEnergy: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true })
    const updateTrack = useLibraryStore.getState().updateTrack
    const ctx = new AudioContext()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = findTrack(id)
      if (!t) continue
      set({ progress: { label: 'energy', current: i + 1, total: ids.length, track: trackLabel(t) } })
      try {
        const ab = await window.api.audio.readFile(t.filePath)
        const buf = await ctx.decodeAudioData(ab)
        const result = await analyzeAudio(buf)
        const current = findTrack(id) ?? t
        const newBpm = result.bpm ?? current.bpm
        const beatgrid = (current.beatgrid.length === 0 && newBpm && result.offsetMs != null)
          ? generateBeatgrid(newBpm, result.offsetMs, buf.duration * 1000)
          : current.beatgrid
        await updateTrack({ id, energy: result.energy ?? current.energy, bpm: newBpm, key: result.key ?? current.key, beatgrid })
      } catch { /* unreadable */ }
    }
    await ctx.close()
    set({ progress: null, running: false })
    toast(`Energy scored for ${ids.length} track${plural(ids.length)}`, 'success')
  },

  analyseBeats: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true })
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = findTrack(id)
      set({ progress: { label: 'beat grid', current: i + 1, total: ids.length, track: t ? trackLabel(t) : '' } })
      try { await window.api.library.analyzeBeats(id) } catch { /* model missing */ }
    }
    await useLibraryStore.getState().loadLibrary()
    set({ progress: null, running: false })
    toast(`Beat grid analysed for ${ids.length} track${plural(ids.length)}`, 'success')
  },

  autoCue: async (ids) => {
    if (get().running || ids.length === 0) return
    set({ running: true })
    const updateTrack = useLibraryStore.getState().updateTrack
    const actx = new AudioContext()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const t = findTrack(id)
      if (!t) continue
      set({ progress: { label: 'auto-cue', current: i + 1, total: ids.length, track: trackLabel(t) } })
      try {
        const ab = await window.api.audio.readFile(t.filePath)
        const buf = await actx.decodeAudioData(ab)
        const result = await analyzeAudio(buf, downbeatsForTrack(t))
        if (result.suggestedCues.length > 0) {
          const cuePoints = result.suggestedCues.map((c, idx) => ({
            index: idx, type: 'hotcue' as const,
            positionMs: c.positionMs, color: c.color, label: c.label,
          }))
          await updateTrack({ id, cuePoints })
        }
      } catch { /* unreadable */ }
    }
    await actx.close()
    set({ progress: null, running: false })
    toast(`Auto-cued ${ids.length} track${plural(ids.length)}`, 'success')
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
