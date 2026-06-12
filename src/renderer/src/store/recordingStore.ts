/**
 * Recording store — manages mix recording state.
 *
 * Captures both deck outputs (deck A + deck B) merged into one MediaRecorder.
 * Produces a WAV-compatible WebM/Ogg blob that the user can save.
 */
import { create } from 'zustand'
import { useDeckAStore, useDeckBStore } from './playerStore'
import { NativeAudioEngine } from '../lib/nativeAudioEngine'

export type RecordingState = 'idle' | 'recording' | 'saving'

interface RecordingStore {
  state: RecordingState
  durationSeconds: number
  startRecording: () => void
  stopRecording: () => Promise<void>
}

let _recorder: MediaRecorder | null = null
let _chunks: Blob[] = []
let _startTime = 0
let _tickId = 0
/** True while the active recording runs through the native master-bus tap. */
let _nativeRec = false

const toast = (msg: string, kind: 'success' | 'error'): void => {
  void import('./toastStore').then(({ useToastStore }) => useToastStore.getState().show(msg, kind))
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  state: 'idle',
  durationSeconds: 0,

  startRecording: () => {
    const engineA = useDeckAStore.getState()._engine
    const engineB = useDeckBStore.getState()._engine

    // Native engine: record the master bus in Rust (16-bit WAV on disk).
    if (engineA instanceof NativeAudioEngine) {
      window.api.engine
        .recordStart()
        .then(() => {
          _nativeRec = true
          _startTime = Date.now()
          _tickId = window.setInterval(() => {
            set({ durationSeconds: Math.floor((Date.now() - _startTime) / 1000) })
          }, 1000)
          set({ state: 'recording', durationSeconds: 0 })
        })
        .catch((err) => toast((err as Error)?.message ?? 'Could not start recording', 'error'))
      return
    }

    const streamA = engineA.recordingStream
    const streamB = engineB.recordingStream
    if (!streamA || !streamB) {
      // Tell the user why instead of failing silently.
      toast('Load a track on both decks before recording.', 'error')
      return
    }

    // Merge both streams using AudioContext + MediaStreamDestination
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()

    const srcA = ctx.createMediaStreamSource(streamA)
    const srcB = ctx.createMediaStreamSource(streamB)
    srcA.connect(dest)
    srcB.connect(dest)

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
      ? 'audio/ogg;codecs=opus'
      : ''

    _chunks = []
    _recorder = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined)
    _recorder.ondataavailable = (e) => { if (e.data.size > 0) _chunks.push(e.data) }
    _recorder.start(1000)
    _startTime = Date.now()

    // Tick duration counter
    _tickId = window.setInterval(() => {
      set({ durationSeconds: Math.floor((Date.now() - _startTime) / 1000) })
    }, 1000)

    set({ state: 'recording', durationSeconds: 0 })
  },

  stopRecording: async () => {
    if (_nativeRec) {
      _nativeRec = false
      set({ state: 'saving' })
      clearInterval(_tickId)
      try {
        const res = await window.api.engine.recordStop()
        const mins = Math.floor(res.seconds / 60)
        const secs = Math.round(res.seconds % 60)
        toast(`Mix saved (${mins}:${secs.toString().padStart(2, '0')}) — ${res.path}`, 'success')
      } catch (err) {
        toast((err as Error)?.message ?? 'Could not save recording', 'error')
      }
      set({ state: 'idle', durationSeconds: 0 })
      return
    }

    if (!_recorder || _recorder.state === 'inactive') return
    set({ state: 'saving' })
    clearInterval(_tickId)

    await new Promise<void>((resolve) => {
      _recorder!.onstop = () => resolve()
      _recorder!.stop()
    })

    const blob = new Blob(_chunks, { type: _recorder.mimeType || 'audio/webm' })
    _chunks = []
    _recorder = null

    // Offer download
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const ts = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
    a.href = url
    a.download = `mix-${ts}.webm`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 30000)

    set({ state: 'idle', durationSeconds: 0 })
  },
}))
