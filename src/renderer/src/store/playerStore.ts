import { create } from 'zustand'
import { AudioEngine } from '../lib/audioEngine'
import { NativeAudioEngine } from '../lib/nativeAudioEngine'
import type { AudioEngineContract } from '../lib/audioEngineContract'
import type { Track, CuePoint, StemKind, StemState, BeatgridMarker, Beatgrid } from '@shared/types'

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
  pitchRange: number          // ±% — e.g. 8 means ±8%; controls slider clamp
  keylockEnabled: boolean     // pitch-preserving tempo (native WSOLA)
  synced: boolean             // slaved to the other deck's transport (shared clock)
  // EQ (dB, -24 to +6)
  eqHigh: number
  eqMid:  number
  eqLow:  number
  /** Per-track auto-gain trim (linear). Applied by lib/mixBus.ts as
   *  engine.volume = trimGain × channel fader × crossfader leg. */
  trimGain: number
  // Performance modes
  isQuantized: boolean        // cues/loops snap to nearest beat
  slipMode: boolean           // playhead advances under loops; exits to real position
  // Flux mode — shadow playhead advances at normal rate while audible head is manipulated
  fluxEnabled: boolean
  // Stem UI state (actual bus routing lives in the engine; this drives the controls)
  stemsVisible: boolean
  stems: Record<StemKind, StemState>
  /** True when four separated stem buses are loaded and driving playback. */
  stemsLoaded: boolean
  /** True while Demucs is separating the current track. */
  stemsSeparating: boolean
  /** Separation progress 0–100. */
  stemsProgress: number
  /** Whether Demucs is installed/available (probed on demand). */
  stemsAvailable: boolean
  separateStems: () => Promise<void>
  unloadStems: () => void
  checkStemsAvailable: () => Promise<void>
  // Analysis
  analysisState: AnalysisState
  analyzeCurrentTrack: () => Promise<void>
  loadTrack: (track: Track) => Promise<void>
  togglePlay: () => void
  seek: (time: number) => void
  /** Begin/end a scrub gesture (needle search) — produces audio while paused. */
  scrubStart: () => void
  scrubEnd: () => void
  setEq: (band: 'high' | 'mid' | 'low', db: number) => void
  pressCue: () => void
  setCue: (index: number) => Promise<void>
  clearCue: (index: number) => Promise<void>
  jumpToCue: (index: number) => void
  setMemoryCue: () => Promise<void>
  // Loop actions
  setLoopIn: () => void
  setLoopOut: () => void
  beatLoop: (bars: number) => void
  loopRoll: (bars: number) => void   // slip-enabled beat loop
  toggleLoop: () => void
  clearLoop: () => void
  // Saved loop slots (cue type: 'loop', indices 0-7)
  saveLoopSlot: (index: number) => Promise<void>
  jumpToLoopSlot: (index: number) => void
  clearLoopSlot: (index: number) => Promise<void>
  // Beat jump
  beatJump: (beats: number) => void
  // Pitch
  setPlaybackRate: (rate: number) => void
  setPitchRange: (range: number) => void
  toggleKeylock: () => void
  /** Beat-sync this deck to the other deck (shared clock), or release if synced. */
  toggleSync: () => void
  // Performance mode toggles
  toggleQuantize: () => void
  toggleSlipMode: () => void
  // Flux mode
  toggleFlux: () => void
  /** Returns the shadow playhead position (seconds) — call from a RAF loop. */
  getFluxTime: () => number
  // Stem controls
  toggleStemsVisible: () => void
  setStemMuted: (kind: StemKind, muted: boolean) => void
  setStemSoloed: (kind: StemKind, soloed: boolean) => void
  setStemGain: (kind: StemKind, gainDb: number) => void
  // Quantiser
  quantiseCurrentTrack: () => Promise<void>
  /**
   * Replace ONLY the loaded track's grid fields (beatgrid / bpm / analysed grid)
   * so quantise, beat-jump and loops use an edited grid immediately — without
   * reloading the audio. Cue points and other deck-local state are preserved.
   * No-op if the id doesn't match the loaded track.
   */
  applyGridEdit: (
    id: string,
    grid: { beatgrid: BeatgridMarker[]; bpm: number; analysedBeatgrid: Beatgrid | null }
  ) => void
  /**
   * Swap this deck's engine to the native Rust backend.
   * Called once at startup when `window.api.engine.isAvailable()` resolves true.
   * No-op if native is already active.
   */
  activateNativeEngine: () => void
  /** The active audio engine (Web Audio or native). */
  _engine: AudioEngineContract
}

// ── Beat / quantise helpers ───────────────────────────────────────────────────

/**
 * Fractional position within the current beat (0–1) from the v2 beatgrid,
 * or null when the track has no usable grid. Used to beat-align SYNC.
 */
function beatPhaseFrac(track: Track | null, timeSec: number): number | null {
  const grid = track?.analysedBeatgrid
  const beats = grid?.beats
  if (!grid || !beats || beats.length < 2) return null
  const ms = timeSec * 1000
  // Binary search for the last beat at or before `ms`.
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (beats[mid].positionMs <= ms) lo = mid
    else hi = mid - 1
  }
  const cur = beats[lo].positionMs
  if (ms < cur) return 0 // before the first beat
  const next =
    lo + 1 < beats.length
      ? beats[lo + 1].positionMs
      : cur + 60000 / (grid.medianBpm || track?.bpm || 120)
  const len = next - cur
  if (len <= 0) return null
  return Math.min(1, (ms - cur) / len)
}

/** Snap a time (seconds) to the nearest beat in the track's beatgrid. */
function snapToBeat(timeSeconds: number, track: Track | null): number {
  if (!track) return timeSeconds
  const posMs = timeSeconds * 1000

  // Prefer v2 beatgrid beat positions
  const beats = track.analysedBeatgrid?.beats
  if (beats && beats.length > 0) {
    let nearest = beats[0].positionMs
    let minDist = Math.abs(posMs - nearest)
    for (const b of beats) {
      if (b.positionMs > posMs + 2000) break
      const d = Math.abs(posMs - b.positionMs)
      if (d < minDist) { minDist = d; nearest = b.positionMs }
    }
    return nearest / 1000
  }

  // Fall back: BPM-based uniform grid
  const bpm = track.bpm ?? 128
  if (!bpm) return timeSeconds
  const beatLen = 60 / bpm
  return Math.round(timeSeconds / beatLen) * beatLen
}

function createDeckStore(deckId: 'A' | 'B') {
  // `engine` is mutable so activateNativeEngine() can swap the backend.
  // All action closures reference `engine` by closure — they pick up the new
  // value automatically after the swap.
  let engine: AudioEngineContract = new AudioEngine()

  // Unsubscribers for the current engine's events — re-wired on swap.
  let _unsubTime:  (() => void) | null = null
  let _unsubEnded: (() => void) | null = null

  function wireEngineEvents(e: AudioEngineContract, setState: (p: Partial<DeckStore>) => void): void {
    _unsubTime?.()
    _unsubEnded?.()
    _unsubTime  = e.onTimeUpdate((t) => setState({ currentTime: t }))
    _unsubEnded = e.onEnded(() => setState({ isPlaying: false, currentTime: 0 }))
  }

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

  // Previous track ID on this deck — used to populate mixedFrom in play events
  let _prevTrackId: string | null = null

  // Monotonic load counter — a finished load only applies its result if no
  // newer load started meanwhile (two in-flight loads used to interleave:
  // track A's waveform/play under track B's title, depending on decode speed).
  let _loadGen = 0

  // Slip mode — wall-clock tracking of "true" position under loops
  let _slipStartPos   = 0
  let _slipStartClock = 0

  function _getSlipPosition(playbackRate: number): number {
    const elapsedSecs = (Date.now() - _slipStartClock) / 1000
    return _slipStartPos + elapsedSecs * playbackRate
  }

  // Flux mode — shadow playhead that advances at tempo while audible is manipulated
  let _fluxStartPos   = 0
  let _fluxStartClock = 0

  const DEFAULT_STEMS: Record<StemKind, StemState> = {
    drums:  { muted: false, soloed: false, gainDb: 0 },
    bass:   { muted: false, soloed: false, gainDb: 0 },
    vocals: { muted: false, soloed: false, gainDb: 0 },
    other:  { muted: false, soloed: false, gainDb: 0 },
  }

  return create<DeckStore>((set, get) => {
    // Wire the initial (Web Audio) engine events
    wireEngineEvents(engine, set)

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
      synced: false,
      playbackRate: 1.0,
      pitchRange: 8,
      keylockEnabled: false,
      eqHigh: 0,
      eqMid:  0,
      eqLow:  0,
      trimGain: 1,
      isQuantized: false,
      slipMode: false,
      fluxEnabled: false,
      stemsVisible: false,
      stems: { ...DEFAULT_STEMS },
      stemsLoaded: false,
      stemsSeparating: false,
      stemsProgress: 0,
      stemsAvailable: false,
      analysisState: 'idle' as AnalysisState,
      _engine: engine,

      loadTrack: async (track) => {
        const gen = ++_loadGen
        _fluxStartPos = 0; _fluxStartClock = Date.now()
        // A new track invalidates any active beat-sync (BPM/phase change).
        if (get().synced) engine.clearSync()
        set({ isLoading: true, currentTrack: track, waveformPeaks: null, detailPeaks: null, lowPeaks: null, midPeaks: null, highPeaks: null, currentTime: 0, mainCueTime: null, loopStart: null, loopEnd: null, isLooping: false, playbackRate: 1.0, eqHigh: 0, eqMid: 0, eqLow: 0, analysisState: 'idle', keylockEnabled: false, synced: false, fluxEnabled: false, stems: { ...DEFAULT_STEMS }, stemsLoaded: false, stemsSeparating: false, stemsProgress: 0 })

        // Per-track auto-gain → trim stage (applied by lib/mixBus.ts as
        // trim × fader × crossfader, so it never compounds across loads and
        // survives fader moves). gainDb is the correction toward −14 dBFS.
        let trim = 1
        try {
          const { useWaveformStore } = await import('./waveformStore')
          if (useWaveformStore.getState().autoGainEnabled && track.gainDb != null) {
            trim = Math.pow(10, track.gainDb / 20)
          }
        } catch { /* non-fatal */ }
        if (gen !== _loadGen) return
        set({ trimGain: Math.max(0, Math.min(4, trim)) })

        try {
          // Pass the file path — engine.load() handles reading internally.
          // Web Audio engine fetches via IPC; native engine reads from disk directly.
          const { peaks, detailPeaks, lowPeaks, midPeaks, highPeaks, duration } = await engine.load(track.filePath)
          if (gen !== _loadGen) return // superseded by a newer load on this deck
          set({ waveformPeaks: peaks, detailPeaks, lowPeaks, midPeaks, highPeaks, duration, isLoading: false })
          // Keep the engine in step with the state reset above — the UI shows
          // keylock off / pitch 1.0 / EQ flat for a fresh track, so the audio
          // must match regardless of which engine is active.
          engine.keylockEnabled = false
          engine.playbackRate = 1.0
          engine.setEqGain('high', 0)
          engine.setEqGain('mid', 0)
          engine.setEqGain('low', 0)
          engine.play()
          set({ isPlaying: true })

          // Auto-load cached stems for this track, if Demucs has already separated it.
          window.api.stems
            .cached(track.id)
            .then((paths) => {
              if (paths && gen === _loadGen && get().currentTrack?.id === track.id) {
                engine.loadStems(paths).then(() => {
                  if (gen === _loadGen) set({ stemsLoaded: true })
                }).catch(() => {})
              }
            })
            .catch(() => {})

          // Record play in DB with provenance (mixedFrom = previous track on this deck)
          const prevId = _prevTrackId
          _prevTrackId = track.id
          window.api.library.recordPlay(track.id, { mixedFrom: prevId ?? undefined, deckId }).then((updated) => {
            // Only patch the deck snapshot if this track is still loaded.
            if (get().currentTrack?.id === updated.id) set({ currentTrack: updated })
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
          // Silently upgrade legacy beatgrid to v2 on first play
          get().quantiseCurrentTrack()
        } catch (err) {
          if (gen !== _loadGen) return
          console.error(`Deck ${deckId}: failed to load`, err)
          set({ isLoading: false })
          const msg = (err as Error)?.message ?? String(err)
          const denied = /EPERM|not permitted|EACCES|operation not permitted/i.test(msg)
          void import('./toastStore').then(({ useToastStore }) => {
            useToastStore.getState().show(
              denied
                ? `Can't read "${track.title || 'track'}" — macOS is blocking file access. Grant Offcut access in System Settings › Privacy & Security › Full Disk Access, then relaunch.`
                : `Couldn't load "${track.title || 'track'}": ${msg.slice(0, 140)}`,
              'error'
            )
          })
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
      scrubStart: () => engine.scrubBegin(),
      scrubEnd: () => engine.scrubEnd(),

      setEq: (band, db) => {
        engine.setEqGain(band, db)
        set(band === 'high' ? { eqHigh: db } : band === 'mid' ? { eqMid: db } : { eqLow: db })
      },

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
        const { currentTrack, currentTime, isQuantized } = get()
        if (!currentTrack) return
        const snappedTime = isQuantized ? snapToBeat(currentTime, currentTrack) : currentTime
        const newCue: CuePoint = {
          index,
          type: 'hotcue',
          positionMs: Math.round(snappedTime * 1000),
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
        const { currentTime, currentTrack, isQuantized, slipMode } = get()
        const t = isQuantized ? snapToBeat(currentTime, currentTrack) : currentTime
        set({ loopStart: t })
        const { loopEnd } = get()
        if (loopEnd !== null && loopEnd > t) {
          if (slipMode) { _slipStartPos = t; _slipStartClock = Date.now() }
          engine.setLoop(t, loopEnd)
          set({ isLooping: true })
        }
      },

      setLoopOut: () => {
        const { currentTime, currentTrack, loopStart, isQuantized, slipMode } = get()
        const t = isQuantized ? snapToBeat(currentTime, currentTrack) : currentTime
        set({ loopEnd: t })
        if (loopStart !== null && loopStart < t) {
          if (slipMode) { _slipStartPos = loopStart; _slipStartClock = Date.now() }
          engine.setLoop(loopStart, t)
          set({ isLooping: true })
        }
      },

      beatLoop: (bars: number) => {
        const { currentTime, currentTrack, isQuantized, slipMode } = get()
        const bpm = currentTrack?.bpm ?? 128
        const barDuration = (60 / bpm) * 4
        const loopLen = bars * barDuration
        const rawStart = isQuantized ? snapToBeat(currentTime, currentTrack) : currentTime
        const start = rawStart
        const end = start + loopLen
        if (slipMode) { _slipStartPos = start; _slipStartClock = Date.now() }
        engine.setLoop(start, end)
        if (!engine.isPlaying) {
          engine.play(start)
          set({ isPlaying: true })
        }
        set({ loopStart: start, loopEnd: end, isLooping: true })
      },

      loopRoll: (bars: number) => {
        // slip-enabled beat loop: engage slip + loop; clearLoop will exit to slip pos
        const { currentTime, currentTrack, isQuantized } = get()
        const bpm = currentTrack?.bpm ?? 128
        const barDuration = (60 / bpm) * 4
        const loopLen = bars * barDuration
        const start = isQuantized ? snapToBeat(currentTime, currentTrack) : currentTime
        const end = start + loopLen
        _slipStartPos = start
        _slipStartClock = Date.now()
        engine.setLoop(start, end)
        if (!engine.isPlaying) { engine.play(start); set({ isPlaying: true }) }
        set({ loopStart: start, loopEnd: end, isLooping: true, slipMode: true })
      },

      toggleLoop: () => {
        const { loopStart, loopEnd, isLooping, slipMode, playbackRate } = get()
        if (isLooping) {
          engine.clearLoop()
          if (slipMode && loopStart !== null) {
            const slipPos = _getSlipPosition(playbackRate)
            engine.seek(Math.max(0, slipPos))
          }
          set({ isLooping: false })
        } else if (loopStart !== null && loopEnd !== null && loopEnd > loopStart) {
          if (slipMode) { _slipStartPos = loopStart; _slipStartClock = Date.now() }
          engine.setLoop(loopStart, loopEnd)
          set({ isLooping: true })
        }
      },

      clearLoop: () => {
        const { isLooping, slipMode, playbackRate } = get()
        engine.clearLoop()
        if (isLooping && slipMode) {
          const slipPos = _getSlipPosition(playbackRate)
          engine.seek(Math.max(0, slipPos))
        }
        set({ loopStart: null, loopEnd: null, isLooping: false })
      },

      // ── Saved loop slots (CuePoint type:'loop', indices 0-7) ──────────
      saveLoopSlot: async (index: number) => {
        const { currentTrack, loopStart, loopEnd } = get()
        if (!currentTrack || loopStart === null || loopEnd === null) return
        const newCue: CuePoint = {
          index,
          type: 'loop',
          positionMs: Math.round(loopStart * 1000),
          endMs: Math.round(loopEnd * 1000),
          color: HOT_CUE_COLORS[index] ?? '#3CA8A1',
          label: `Loop ${index + 1}`,
        }
        const rest = currentTrack.cuePoints.filter((c) => !(c.type === 'loop' && c.index === index))
        await patchTrackCues([...rest, newCue].sort((a, b) => a.positionMs - b.positionMs), get, set)
      },

      jumpToLoopSlot: (index: number) => {
        const { currentTrack, slipMode } = get()
        const slot = currentTrack?.cuePoints.find((c) => c.type === 'loop' && c.index === index)
        if (!slot) return
        const start = slot.positionMs / 1000
        const end = (slot.endMs ?? slot.positionMs + 2000) / 1000
        if (slipMode) { _slipStartPos = start; _slipStartClock = Date.now() }
        engine.setLoop(start, end)
        engine.seek(start)
        if (!engine.isPlaying) { engine.play(start); set({ isPlaying: true }) }
        set({ loopStart: start, loopEnd: end, isLooping: true })
      },

      clearLoopSlot: async (index: number) => {
        const { currentTrack } = get()
        if (!currentTrack) return
        await patchTrackCues(
          currentTrack.cuePoints.filter((c) => !(c.type === 'loop' && c.index === index)),
          get, set
        )
      },

      // ── Beat Jump ─────────────────────────────────────────────────────
      beatJump: (beats: number) => {
        const { currentTime, currentTrack, duration, isQuantized } = get()
        if (!currentTrack) return
        const bpm = currentTrack.bpm ?? 128
        const beatLen = 60 / bpm
        const raw = currentTime + beats * beatLen
        const clamped = Math.max(0, Math.min(duration, raw))
        const target = isQuantized ? snapToBeat(clamped, currentTrack) : clamped
        engine.seek(target)
        set({ currentTime: target })
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
          if (latest.mood == null && result.mood != null) patch.mood = result.mood

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
        const { pitchRange } = get()
        const limit = pitchRange / 100
        const clamped = Math.max(1 - limit, Math.min(1 + limit, rate))
        engine.playbackRate = clamped
        set({ playbackRate: clamped })
      },
      setPitchRange: (range: number) => {
        set({ pitchRange: range })
        // Re-clamp current rate to new range
        const { playbackRate } = get()
        const limit = range / 100
        const clamped = Math.max(1 - limit, Math.min(1 + limit, playbackRate))
        if (clamped !== playbackRate) {
          engine.playbackRate = clamped
          set({ playbackRate: clamped })
        }
      },
      toggleKeylock: () => {
        const next = !get().keylockEnabled
        engine.keylockEnabled = next
        set({ keylockEnabled: next })
      },
      toggleSync: () => {
        if (get().synced) {
          engine.clearSync()
          set({ synced: false })
          return
        }
        // Slave this deck to the other one: match its tempo (BPM ratio) and lock
        // the current playhead offset (phase), so they stay in step from here.
        const masterId = deckId === 'A' ? 'B' : 'A'
        const masterStore = deckId === 'A' ? useDeckBStore : useDeckAStore
        const master = masterStore.getState()
        const slaveTrack = get().currentTrack
        const masterBpm = master.currentTrack?.bpm ?? 0
        const slaveBpm = slaveTrack?.bpm ?? 0
        if (!masterBpm || !slaveBpm) {
          import('./toastStore').then(({ useToastStore }) =>
            useToastStore.getState().show('Both decks need a BPM to sync', 'error')
          )
          return
        }
        if (master.synced) {
          // Avoid mutual sync (A→B and B→A would fight / cycle).
          import('./toastStore').then(({ useToastStore }) =>
            useToastStore.getState().show('Unsync the other deck first', 'error')
          )
          return
        }
        const ratio = masterBpm / slaveBpm
        // Beat-align the lock when both tracks have analysed beatgrids: shift
        // the slave by up to ±half a beat so its beat phase matches the
        // master's (what BEAT SYNC does on a CDJ). Falls back to plain
        // "lock from here" when either grid is missing.
        let phase = get().currentTime - master.currentTime * ratio
        const fm = beatPhaseFrac(master.currentTrack, master.currentTime)
        const fs = beatPhaseFrac(slaveTrack, get().currentTime)
        if (fm !== null && fs !== null) {
          let d = fm - fs // slave shift in beats
          if (d > 0.5) d -= 1
          if (d < -0.5) d += 1
          const target = get().currentTime + d * (60 / slaveBpm)
          phase = target - master.currentTime * ratio
        }
        engine.syncTo(masterId, ratio, phase)
        // Reflect the matched tempo on the slider; the engine clamps internally.
        engine.playbackRate = ratio
        set({ synced: true, playbackRate: ratio })
      },
      toggleQuantize: () => set((s) => ({ isQuantized: !s.isQuantized })),
      toggleSlipMode: () => set((s) => ({ slipMode: !s.slipMode })),

      // ── Flux mode ─────────────────────────────────────────────────────────
      toggleFlux: () => {
        const { fluxEnabled, currentTime, playbackRate } = get()
        if (!fluxEnabled) {
          // Engaging flux: anchor shadow at current audible position
          _fluxStartPos   = currentTime
          _fluxStartClock = Date.now()
          set({ fluxEnabled: true })
        } else {
          // Disengaging: snap audible to where we would have been
          const elapsed = (Date.now() - _fluxStartClock) / 1000
          const shadowPos = Math.max(0, _fluxStartPos + elapsed * playbackRate)
          engine.seek(shadowPos)
          set({ fluxEnabled: false, currentTime: shadowPos })
        }
      },

      getFluxTime: () => {
        const { playbackRate } = get()
        const elapsed = (Date.now() - _fluxStartClock) / 1000
        return Math.max(0, _fluxStartPos + elapsed * playbackRate)
      },

      // ── Stem controls ─────────────────────────────────────────────────────
      toggleStemsVisible: () => set((s) => ({ stemsVisible: !s.stemsVisible })),

      setStemMuted: (kind, muted) => {
        engine.setStemMuted(kind, muted)
        set((s) => ({ stems: { ...s.stems, [kind]: { ...s.stems[kind], muted } } }))
      },

      setStemSoloed: (kind, soloed) => {
        engine.setStemSoloed(kind, soloed)
        set((s) => ({ stems: { ...s.stems, [kind]: { ...s.stems[kind], soloed } } }))
      },

      setStemGain: (kind, gainDb) => {
        engine.setStemGain(kind, gainDb)
        set((s) => ({ stems: { ...s.stems, [kind]: { ...s.stems[kind], gainDb } } }))
      },

      checkStemsAvailable: async () => {
        try {
          const s = await window.api.stems.status()
          set({ stemsAvailable: s.available })
        } catch {
          set({ stemsAvailable: false })
        }
      },

      separateStems: async () => {
        const track = get().currentTrack
        if (!track || get().stemsSeparating) return
        set({ stemsSeparating: true, stemsProgress: 0 })
        const off = window.api.stems.onProgress((p) => {
          if (p.trackId === track.id) set({ stemsProgress: p.percent })
        })
        try {
          const res = await window.api.stems.separate(track.id, track.filePath)
          if (res.ok && res.paths && get().currentTrack?.id === track.id) {
            await engine.loadStems(res.paths)
            set({ stemsLoaded: true })
            const { useToastStore } = await import('./toastStore')
            useToastStore.getState().show(`Stems ready for "${track.title}"`, 'success')
          } else if (!res.ok) {
            const { useToastStore } = await import('./toastStore')
            useToastStore.getState().show(res.error || 'Stem separation failed', 'error')
          }
        } catch (err) {
          const { useToastStore } = await import('./toastStore')
          useToastStore.getState().show((err as Error)?.message ?? 'Stem separation failed', 'error')
        } finally {
          off()
          set({ stemsSeparating: false, stemsProgress: 0 })
        }
      },

      unloadStems: () => {
        engine.unloadStems()
        set({ stemsLoaded: false })
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
      },

      // ── Quantiser ─────────────────────────────────────────────────────────
      quantiseCurrentTrack: async () => {
        const { currentTrack } = get()
        if (!currentTrack) return
        // Already has v2 grid — nothing to do
        if (currentTrack.analysedBeatgrid) return
        // No legacy markers either — quantiser will run via analyzeBeats if model available
        if (!currentTrack.beatgrid?.length) return

        try {
          const { fromBeatgridMarkers } = await import('../lib/quantiser')
          const sorted = [...currentTrack.beatgrid].sort((a, b) => a.positionMs - b.positionMs)
          const v2 = fromBeatgridMarkers(sorted, currentTrack.bpm ? 'tags' : 'mock')
          const updated = await window.api.library.updateTrack({
            id: currentTrack.id,
            analysedBeatgrid: v2
          })
          set({ currentTrack: updated })
          const { useLibraryStore } = await import('./libraryStore')
          useLibraryStore.setState((s) => ({
            tracks: s.tracks.map((t) => (t.id === updated.id ? updated : t))
          }))
        } catch { /* non-fatal — legacy grid still works */ }
      },

      applyGridEdit: (id, grid) => {
        const { currentTrack } = get()
        if (!currentTrack || currentTrack.id !== id) return
        // Merge only the grid fields so beat-snap/jump/loop pick up the edit live;
        // keep cuePoints and the rest of the loaded snapshot intact.
        set({
          currentTrack: {
            ...currentTrack,
            beatgrid: grid.beatgrid,
            bpm: grid.bpm,
            analysedBeatgrid: grid.analysedBeatgrid
          }
        })
      },

      // ── Native engine activation ───────────────────────────────────────────
      activateNativeEngine: () => {
        // Already on native — nothing to do.
        if (engine instanceof NativeAudioEngine) return

        const native = new NativeAudioEngine(deckId)

        // Transfer persistent settings to the new engine.
        const s = get()
        native.keylockEnabled = s.keylockEnabled
        native.playbackRate   = s.playbackRate
        native.setEqGain('high', s.eqHigh)
        native.setEqGain('mid',  s.eqMid)
        native.setEqGain('low',  s.eqLow)

        // Swap the engine — all action closures pick up the new reference
        // immediately, and the _engine change below makes lib/mixBus.ts push
        // the current trim × fader × crossfader volume to the new backend.
        engine = native
        wireEngineEvents(native, set)
        set({ _engine: native })

        console.info(`[Deck ${deckId}] switched to native audio engine`)
      },
    }
  })
}

export const useDeckAStore = createDeckStore('A')
export const useDeckBStore = createDeckStore('B')

// Legacy alias so any remaining imports of usePlayerStore still compile
export const usePlayerStore = useDeckAStore
