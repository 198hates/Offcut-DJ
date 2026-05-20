import { create } from 'zustand'
import { AudioEngine } from '../lib/audioEngine'
import type { Track, CuePoint } from '@shared/types'

export const HOT_CUE_COLORS = [
  '#e91e63', '#ff9800', '#ffeb3b', '#4caf50',
  '#00bcd4', '#2196f3', '#9c27b0', '#f44336'
]
export const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

export type AnalysisState = 'idle' | 'reading-tags' | 'analyzing' | 'done' | 'error'

export interface DeckStore {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  waveformPeaks: Float32Array | null
  detailPeaks: Float32Array | null
  lowPeaks: Float32Array | null
  midPeaks: Float32Array | null
  highPeaks: Float32Array | null
  isLoading: boolean
  mainCueTime: number | null
  // Loop
  loopStart: number | null
  loopEnd: number | null
  isLooping: boolean
  // Pitch
  playbackRate: number
  // Analysis
  analysisState: AnalysisState
  analyzeCurrentTrack: () => Promise<void>
  loadTrack: (track: Track) => Promise<void>
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  pressCue: () => void
  setCue: (index: number) => Promise<void>
  clearCue: (index: number) => Promise<void>
  jumpToCue: (index: number) => void
  setMemoryCue: () => Promise<void>
  // Loop actions
  setLoopIn: () => void
  setLoopOut: () => void
  beatLoop: (bars: number) => void
  toggleLoop: () => void
  clearLoop: () => void
  // Pitch action
  setPlaybackRate: (rate: number) => void
  _engine: AudioEngine
}

function createDeckStore(deckId: 'A' | 'B') {
  const engine = new AudioEngine()

  const patchTrackCues = async (
    cuePoints: CuePoint[],
    getState: () => DeckStore,
    setState: (p: Partial<DeckStore>) => void
  ): Promise<void> => {
    const { currentTrack } = getState()
    if (!currentTrack) return
    const updated = await window.api.library.updateTrack({ id: currentTrack.id, cuePoints })
    setState({ currentTrack: updated })
    const { useLibraryStore } = await import('./libraryStore')
    useLibraryStore.setState((s) => ({
      tracks: s.tracks.map((t) => (t.id === updated.id ? updated : t))
    }))
  }

  return create<DeckStore>((set, get) => {
    engine.onTimeUpdate((t) => set({ currentTime: t }))
    engine.onEnded(() => set({ isPlaying: false, currentTime: 0 }))

    return {
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      waveformPeaks: null,
      detailPeaks: null,
      lowPeaks: null,
      midPeaks: null,
      highPeaks: null,
      isLoading: false,
      mainCueTime: null,
      loopStart: null,
      loopEnd: null,
      isLooping: false,
      playbackRate: 1.0,
      analysisState: 'idle' as AnalysisState,
      _engine: engine,

      loadTrack: async (track) => {
        set({ isLoading: true, currentTrack: track, waveformPeaks: null, detailPeaks: null, lowPeaks: null, midPeaks: null, highPeaks: null, currentTime: 0, mainCueTime: null, loopStart: null, loopEnd: null, isLooping: false, playbackRate: 1.0, analysisState: 'idle' })
        try {
          const ab = await window.api.audio.readFile(track.filePath)
          const { peaks, detailPeaks, lowPeaks, midPeaks, highPeaks, duration } = await engine.load(ab)
          set({ waveformPeaks: peaks, detailPeaks, lowPeaks, midPeaks, highPeaks, duration, isLoading: false })
          engine.play()
          set({ isPlaying: true })

          // Record play in DB and patch library store state
          window.api.library.recordPlay(track.id).then((updated) => {
            set({ currentTrack: updated })
            import('./libraryStore').then(({ useLibraryStore }) => {
              useLibraryStore.setState((s) => ({
                tracks: s.tracks.map((t) => (t.id === updated.id ? updated : t))
              }))
            })
          }).catch(() => { /* non-fatal */ })

          // Auto-analyze if BPM or key is missing
          if (!track.bpm || !track.key) {
            get().analyzeCurrentTrack()
          }
        } catch (err) {
          console.error(`Deck ${deckId}: failed to load`, err)
          set({ isLoading: false })
        }
      },

      togglePlay: () => {
        if (get().isPlaying) {
          engine.pause()
          set({ isPlaying: false })
        } else {
          if (!get().currentTrack) return
          engine.play()
          set({ isPlaying: true })
        }
      },

      seek: (time) => {
        engine.seek(time)
        set({ currentTime: time })
      },

      setVolume: (v) => { engine.volume = v },

      pressCue: () => {
        const { isPlaying, currentTime, mainCueTime } = get()
        if (isPlaying) {
          const t = mainCueTime ?? 0
          engine.seek(t)
          engine.pause()
          set({ isPlaying: false, currentTime: t })
        } else if (mainCueTime !== null && Math.abs(currentTime - mainCueTime) < 0.05) {
          engine.play()
          set({ isPlaying: true })
        } else {
          set({ mainCueTime: currentTime })
        }
      },

      setCue: async (index) => {
        const { currentTrack, currentTime } = get()
        if (!currentTrack) return
        const newCue: CuePoint = {
          index,
          type: 'hotcue',
          positionMs: Math.round(currentTime * 1000),
          color: HOT_CUE_COLORS[index] ?? '#ff8c00',
          label: HOT_CUE_LABELS[index] ?? String(index + 1)
        }
        const rest = currentTrack.cuePoints.filter((c) => !(c.type === 'hotcue' && c.index === index))
        await patchTrackCues([...rest, newCue].sort((a, b) => a.positionMs - b.positionMs), get, set)
      },

      clearCue: async (index) => {
        const { currentTrack } = get()
        if (!currentTrack) return
        await patchTrackCues(
          currentTrack.cuePoints.filter((c) => !(c.type === 'hotcue' && c.index === index)),
          get, set
        )
      },

      jumpToCue: (index) => {
        const cue = get().currentTrack?.cuePoints.find((c) => c.type === 'hotcue' && c.index === index)
        if (cue) engine.seek(cue.positionMs / 1000)
      },

      // ── Loop ──────────────────────────────────────────────────────────
      setLoopIn: () => {
        const { currentTime } = get()
        set({ loopStart: currentTime })
        // If we already have a loopEnd past this point, activate immediately
        const { loopEnd } = get()
        if (loopEnd !== null && loopEnd > currentTime) {
          engine.setLoop(currentTime, loopEnd)
          set({ isLooping: true })
        }
      },

      setLoopOut: () => {
        const { currentTime, loopStart } = get()
        set({ loopEnd: currentTime })
        if (loopStart !== null && loopStart < currentTime) {
          engine.setLoop(loopStart, currentTime)
          set({ isLooping: true })
        }
      },

      beatLoop: (bars: number) => {
        const { currentTime, currentTrack } = get()
        const bpm = currentTrack?.bpm ?? 128
        const barDuration = (60 / bpm) * 4
        const loopLen = bars * barDuration
        const start = currentTime
        const end = currentTime + loopLen
        engine.setLoop(start, end)
        // If not playing, start playback from loop start
        if (!engine.isPlaying) {
          engine.play(start)
          set({ isPlaying: true })
        }
        set({ loopStart: start, loopEnd: end, isLooping: true })
      },

      toggleLoop: () => {
        const { loopStart, loopEnd, isLooping } = get()
        if (isLooping) {
          engine.clearLoop()
          set({ isLooping: false })
        } else if (loopStart !== null && loopEnd !== null && loopEnd > loopStart) {
          engine.setLoop(loopStart, loopEnd)
          set({ isLooping: true })
        }
      },

      clearLoop: () => {
        engine.clearLoop()
        set({ loopStart: null, loopEnd: null, isLooping: false })
      },

      // ── Analysis ──────────────────────────────────────────────────────
      analyzeCurrentTrack: async () => {
        const { currentTrack } = get()
        if (!currentTrack) return

        // 1. Try reading existing tags first (fast)
        set({ analysisState: 'reading-tags' })
        try {
          const tags = await window.api.audio.readTags(currentTrack.filePath)
          if (tags) {
            const patch: Partial<Track> = {}
            if (!currentTrack.bpm && tags.bpm) patch.bpm = tags.bpm
            if (!currentTrack.key && tags.key) patch.key = tags.key
            if (Object.keys(patch).length > 0) {
              const updated = await window.api.library.updateTrack({ id: currentTrack.id, ...patch })
              set({ currentTrack: updated })
              const { useLibraryStore } = await import('./libraryStore')
              useLibraryStore.setState((s) => ({ tracks: s.tracks.map((t) => t.id === updated.id ? updated : t) }))
              // If we got both, we're done
              const refreshed = get().currentTrack!
              if (refreshed.bpm && refreshed.key) { set({ analysisState: 'done' }); return }
            }
          }
        } catch { /* tags unreadable, fall through to audio analysis */ }

        // 2. Full audio analysis (uses the already-decoded buffer via audioEngine)
        set({ analysisState: 'analyzing' })
        try {
          const { analyzeAudio } = await import('../lib/analyzer')
          // Re-read the file to get the AudioBuffer for analysis
          const ab = await window.api.audio.readFile(currentTrack.filePath)
          const ctx = new AudioContext()
          const buffer = await ctx.decodeAudioData(ab)
          ctx.close()

          const result = await analyzeAudio(buffer)
          const { currentTrack: latest } = get()
          if (!latest) return

          const patch: Partial<Track> = {}
          if (!latest.bpm && result.bpm) patch.bpm = result.bpm
          if (!latest.key && result.key) patch.key = result.key

          if (Object.keys(patch).length > 0) {
            const updated = await window.api.library.updateTrack({ id: latest.id, ...patch })
            set({ currentTrack: updated, analysisState: 'done' })
            const { useLibraryStore } = await import('./libraryStore')
            useLibraryStore.setState((s) => ({ tracks: s.tracks.map((t) => t.id === updated.id ? updated : t) }))
          } else {
            set({ analysisState: 'done' })
          }
        } catch (err) {
          console.error(`Deck ${deckId}: analysis failed`, err)
          set({ analysisState: 'error' })
        }
      },

      // ── Pitch ─────────────────────────────────────────────────────────
      setPlaybackRate: (rate: number) => {
        engine.playbackRate = rate
        set({ playbackRate: rate })
      },

      setMemoryCue: async () => {
        const { currentTrack, currentTime } = get()
        if (!currentTrack) return
        const newCue: CuePoint = {
          index: currentTrack.cuePoints.filter((c) => c.type === 'memory').length,
          type: 'memory',
          positionMs: Math.round(currentTime * 1000),
          color: '#f59e0b',
          label: ''
        }
        await patchTrackCues(
          [...currentTrack.cuePoints, newCue].sort((a, b) => a.positionMs - b.positionMs),
          get, set
        )
      }
    }
  })
}

export const useDeckAStore = createDeckStore('A')
export const useDeckBStore = createDeckStore('B')

// Legacy alias so any remaining imports of usePlayerStore still compile
export const usePlayerStore = useDeckAStore
