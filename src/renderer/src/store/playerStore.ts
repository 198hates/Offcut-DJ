import { create } from 'zustand'
import { audioEngine } from '../lib/audioEngine'
import type { Track, CuePoint } from '@shared/types'

// Default hotcue colours A–H (matches Rekordbox palette)
export const HOT_CUE_COLORS = [
  '#e91e63', '#ff9800', '#ffeb3b', '#4caf50',
  '#00bcd4', '#2196f3', '#9c27b0', '#f44336'
]
export const HOT_CUE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

interface PlayerStore {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  waveformPeaks: Float32Array | null
  isLoading: boolean
  loadTrack: (track: Track) => Promise<void>
  togglePlay: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  // Cue editing
  setCue: (index: number) => Promise<void>
  clearCue: (index: number) => Promise<void>
  jumpToCue: (index: number) => void
  setMemoryCue: () => Promise<void>
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  audioEngine.onTimeUpdate((t) => set({ currentTime: t }))
  audioEngine.onEnded(() => set({ isPlaying: false, currentTime: 0 }))

  const patchTrackCues = async (cuePoints: CuePoint[]): Promise<void> => {
    const { currentTrack } = get()
    if (!currentTrack) return
    const updated = await window.api.library.updateTrack({ id: currentTrack.id, cuePoints })
    set({ currentTrack: updated })
    // Patch library store in-place so the table stays consistent
    const { useLibraryStore } = await import('./libraryStore')
    useLibraryStore.setState((s) => ({
      tracks: s.tracks.map((t) => (t.id === updated.id ? updated : t))
    }))
  }

  return {
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    waveformPeaks: null,
    isLoading: false,

    loadTrack: async (track) => {
      set({ isLoading: true, currentTrack: track, waveformPeaks: null, currentTime: 0 })
      try {
        const ab = await window.api.audio.readFile(track.filePath)
        const { peaks, duration } = await audioEngine.load(ab)
        set({ waveformPeaks: peaks, duration, isLoading: false })
        audioEngine.play()
        set({ isPlaying: true })
      } catch (err) {
        console.error('Player: failed to load track', err)
        set({ isLoading: false })
      }
    },

    togglePlay: () => {
      if (get().isPlaying) {
        audioEngine.pause()
        set({ isPlaying: false })
      } else {
        if (!get().currentTrack) return
        audioEngine.play()
        set({ isPlaying: true })
      }
    },

    seek: (time) => {
      audioEngine.seek(time)
      set({ currentTime: time })
    },

    setVolume: (v) => { audioEngine.volume = v },

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
      const rest = currentTrack.cuePoints.filter(
        (c) => !(c.type === 'hotcue' && c.index === index)
      )
      await patchTrackCues([...rest, newCue].sort((a, b) => a.positionMs - b.positionMs))
    },

    clearCue: async (index) => {
      const { currentTrack } = get()
      if (!currentTrack) return
      await patchTrackCues(
        currentTrack.cuePoints.filter((c) => !(c.type === 'hotcue' && c.index === index))
      )
    },

    jumpToCue: (index) => {
      const { currentTrack } = get()
      const cue = currentTrack?.cuePoints.find(
        (c) => c.type === 'hotcue' && c.index === index
      )
      if (cue) audioEngine.seek(cue.positionMs / 1000)
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
        [...currentTrack.cuePoints, newCue].sort((a, b) => a.positionMs - b.positionMs)
      )
    }
  }
})
