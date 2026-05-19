import { create } from 'zustand'
import { audioEngine } from '../lib/audioEngine'
import type { Track } from '@shared/types'

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
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  audioEngine.onTimeUpdate((t) => set({ currentTime: t }))
  audioEngine.onEnded(() => set({ isPlaying: false, currentTime: 0 }))

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
  }
})
