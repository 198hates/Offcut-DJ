/**
 * AudioEngineContract — the shared interface all audio backend implementations must satisfy.
 *
 * Both the current Web Audio engine (audioEngine.ts) and the native Rust engine
 * (nativeAudioEngine.ts → main/engine/index.ts) implement this interface.
 * The deck store (playerStore.ts) works exclusively against this contract, making
 * the two backends completely swappable.
 *
 * id·2026·009 — Phase 1: contract formalisation
 */

import type { StemKind } from '@shared/types'

// ── LoadResult ────────────────────────────────────────────────────────────────

/**
 * Returned by `load()` once an audio file is ready for playback.
 * Contains pre-computed peak arrays for the waveform display at multiple
 * resolutions, plus the track duration.
 */
export interface LoadResult {
  /** Total track duration in seconds. */
  duration: number
  /** 1 000-bucket amplitude overview — used by the compact waveform. */
  peaks: Float32Array
  /** 8 000-bucket detail peaks — used by the zoomed waveform. */
  detailPeaks: Float32Array
  /** Bass band peaks (20–300 Hz) — 8 000 buckets. */
  lowPeaks: Float32Array
  /** Mid band peaks (300–3 kHz) — 8 000 buckets. */
  midPeaks: Float32Array
  /** High band peaks (3–20 kHz) — 8 000 buckets. */
  highPeaks: Float32Array
}

// ── AudioEngineContract ───────────────────────────────────────────────────────

export interface AudioEngineContract {
  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Load an audio file for playback and compute waveform data.
   *
   * `source` may be:
   *   - A string file path  → preferred; native engine loads directly from disk.
   *   - An ArrayBuffer      → legacy; Web Audio engine still accepts raw PCM.
   *
   * Resolves once the file is decoded and ready to play. The waveform peak
   * arrays in the resolved `LoadResult` are Float32Arrays of length 1 000 /
   * 8 000 depending on resolution.
   */
  load(source: string | ArrayBuffer): Promise<LoadResult>

  // ── Playback ─────────────────────────────────────────────────────────────

  /** Start playback. If `from` is provided, seek there first (seconds). */
  play(from?: number): void
  /** Pause playback at the current position. */
  pause(): void
  /** Seek to `seconds`. Maintains play/pause state. */
  seek(seconds: number): void
  /** Current playback position in seconds. */
  readonly currentTime: number
  /** Total duration of the loaded audio in seconds. */
  readonly duration: number
  /** True while the engine is actively playing. */
  readonly isPlaying: boolean

  // ── Loop ─────────────────────────────────────────────────────────────────

  /** Arm a loop between `start` and `end` (both in seconds) and start looping. */
  setLoop(start: number, end: number): void
  /** Disarm the loop without seeking. */
  clearLoop(): void
  readonly isLooping: boolean
  readonly loopStart: number
  readonly loopEnd: number

  // ── EQ (dB, −24 to +6) ──────────────────────────────────────────────────

  /** Apply gain to one of three fixed EQ bands.
   *  `'low'`  — low shelf  ~200 Hz
   *  `'mid'`  — peaking   ~1 kHz
   *  `'high'` — high shelf ~8 kHz
   */
  setEqGain(band: 'high' | 'mid' | 'low', db: number): void
  readonly eqHighGain: number
  readonly eqMidGain:  number
  readonly eqLowGain:  number

  // ── Pitch / Tempo ────────────────────────────────────────────────────────

  /**
   * Playback rate multiplier (0.5–2.0).
   * Without keylock enabled this shifts both tempo AND pitch (chipmunk effect).
   * With keylock enabled the pitch is preserved via time-stretching (Phase 2).
   */
  set playbackRate(rate: number)
  get playbackRate(): number

  /**
   * Enable/disable keylock (pitch-preserving tempo change).
   * Phase 2: wired to RubberBand via napi-rs.
   * Until then: the setting is stored and respected when the native engine loads.
   */
  set keylockEnabled(v: boolean)
  get keylockEnabled(): boolean

  // ── Volume ───────────────────────────────────────────────────────────────

  /** Channel fader level (0–1 linear). */
  set volume(v: number)
  get volume(): number

  // ── Stems ────────────────────────────────────────────────────────────────

  /**
   * Set the trim gain (dB) for a stem bus.
   * Pre-demucs: no audio effect (full mix is on one bus).
   * Post-demucs (Phase 3+): applied to the individual stem PCM bus.
   */
  setStemGain(kind: StemKind, db: number): void
  /** Mute a stem bus. */
  setStemMuted(kind: StemKind, muted: boolean): void
  /** Solo a stem bus (exclusive: other buses are silenced). */
  setStemSoloed(kind: StemKind, soloed: boolean): void

  // ── Output routing ───────────────────────────────────────────────────────

  /**
   * Route this deck's output to a specific audio output device.
   * `deviceId` is an OS device identifier (e.g. CoreAudio UID on macOS,
   * WasAPI device ID on Windows, ALSA card string on Linux).
   * Phase 2+: implemented in the Rust engine via cpal.
   */
  setOutputDevice(deviceId: string): Promise<void>

  // ── Inter-deck sync ──────────────────────────────────────────────────────

  /**
   * Lock this engine's tempo to `master` so both decks share the same clock.
   * Phase 4: implemented once the shared Rust clock is running.
   */
  syncTo(master: AudioEngineContract): void

  // ── VU metering ──────────────────────────────────────────────────────────

  /** Post-fader RMS level, 0–1 linear. Call from a RAF loop. */
  getLevel(): number

  // ── Recording (Web Audio only) ────────────────────────────────────────────

  /**
   * A MediaStream of this deck's post-fader output for mix recording.
   * `null` when the native Rust engine is active — recording is not yet
   * supported for native output (requires a virtual audio loopback, Phase 6+).
   */
  readonly recordingStream: MediaStream | null

  // ── Event subscriptions ──────────────────────────────────────────────────

  /** Register a callback fired ~60 fps with the current playback time (seconds).
   *  Returns an unsubscribe function. */
  onTimeUpdate(cb: (t: number) => void): () => void

  /** Register a callback fired when the track naturally reaches its end.
   *  Returns an unsubscribe function. */
  onEnded(cb: () => void): () => void
}
