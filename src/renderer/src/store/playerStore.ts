import { create } from 'zustand'
import { AudioEngine } from '../lib/audioEngine'
import type { Track, CuePoint } from '@shared/types'

export const HOT_CUE_COLORS = [
  '#e91e63', '#ff9800', '#ffeb3b', '#4caf50',
  '#00bcd4', '#2196f3', '#9c27b0', '#f44336'
]
export const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

export interface DeckStore {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  waveformPeaks: Float32Array | null
  detailPeaks: Float32Array | null
  isLoading: boolean
  mainCueTime: number | null
  // Loop
  loopStart: number | null
  loopEnd: number | null
  isLooping: boolean
  // Pitch
  playbackRate: number
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
      isLoading: false,
      mainCueTime: null,
      loopStart: null,
      loopEnd: null,
      isLooping: false,
      playbackRate: 1.0,
      _engine: engine,

      loadTrack: async (track) => {
        set({ isLoading: true, currentTrack: track, waveformPeaks: null, detailPeaks: null, currentTime: 0, mainCueTime: null, loopStart: null, loopEnd: null, isLooping: false, playbackRate: 1.0 })
        try {
          const ab = await window.api.audio.readFile(track.filePath)
          const { peaks, detailPeaks, duration } = await engine.load(ab)
          set({ waveformPeaks: peaks, detailPeaks, duration, isLoading: false })
          engine.play()
          set({ isPlaying: true })
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
