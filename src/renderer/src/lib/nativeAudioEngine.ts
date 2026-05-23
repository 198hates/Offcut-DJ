/**
 * NativeAudioEngine — renderer-side IPC bridge to the Rust audio engine.
 *
 * Implements AudioEngineContract identically to AudioEngine, but routes all
 * calls through `window.api.engine.*` IPC instead of Web Audio.
 *
 * The Rust engine (native/audio-engine/) runs in the main process and owns
 * the audio hardware. This class is a thin command-sender + event-receiver.
 *
 * id·2026·009 — Phase 2+ (active once native addon is compiled & loaded)
 */

import type { AudioEngineContract, LoadResult } from './audioEngineContract'
import type { StemKind } from '@shared/types'

type TimeCallback = (time: number) => void
type VoidCallback = () => void

export class NativeAudioEngine implements AudioEngineContract {
  private readonly deckId: 'A' | 'B'
  private _currentTime   = 0
  private _duration      = 0
  private _isPlaying     = false
  private _volume        = 0.8
  private _rate          = 1.0
  private _keylock       = false
  private _looping       = false
  private _loopStart     = 0
  private _loopEnd       = 0
  private _eqHigh        = 0
  private _eqMid         = 0
  private _eqLow         = 0
  private _lastLevel     = 0   // cached from timeUpdate push (level piggybacks on time event)

  private timeCbs: TimeCallback[] = []
  private endCbs:  VoidCallback[] = []
  private unsubTime: (() => void) | null = null
  private unsubEnded: (() => void) | null = null

  constructor(deckId: 'A' | 'B') {
    this.deckId = deckId
    this._subscribeToEvents()
  }

  // ── Event subscriptions from main process ────────────────────────────────

  private _subscribeToEvents(): void {
    // The main process piggybacks the RMS level onto every time-update event.
    // Cast the callback signature to allow the extra parameter.
    this.unsubTime = window.api.engine.onTimeUpdate(
      this.deckId,
      (time: number, level?: number) => {
        this._currentTime = time
        if (level !== undefined) this._lastLevel = level
        this.timeCbs.forEach((cb) => cb(time))
      }
    )
    this.unsubEnded = window.api.engine.onEnded(this.deckId, () => {
      this._isPlaying = false
      this._currentTime = 0
      this.endCbs.forEach((cb) => cb())
    })
  }

  dispose(): void {
    this.unsubTime?.()
    this.unsubEnded?.()
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async load(source: string | ArrayBuffer): Promise<LoadResult> {
    if (source instanceof ArrayBuffer) {
      throw new Error('NativeAudioEngine: ArrayBuffer not supported — pass a file path string.')
    }
    const result = await window.api.engine.load(this.deckId, source)
    this._duration     = result.duration
    this._currentTime  = 0
    this._isPlaying    = false
    // Convert plain number[] → Float32Array (IPC serialises typed arrays as plain arrays)
    return {
      duration:    result.duration,
      peaks:       new Float32Array(result.peaks),
      detailPeaks: new Float32Array(result.detailPeaks),
      lowPeaks:    new Float32Array(result.lowPeaks),
      midPeaks:    new Float32Array(result.midPeaks),
      highPeaks:   new Float32Array(result.highPeaks),
    }
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  play(from?: number): void {
    window.api.engine.play(this.deckId, from)
    this._isPlaying = true
  }

  pause(): void {
    window.api.engine.pause(this.deckId)
    this._isPlaying = false
  }

  seek(seconds: number): void {
    window.api.engine.seek(this.deckId, seconds)
    this._currentTime = seconds
  }

  get currentTime(): number { return this._currentTime }
  get duration():    number { return this._duration    }
  get isPlaying():   boolean { return this._isPlaying  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  setLoop(start: number, end: number): void {
    this._looping   = true
    this._loopStart = start
    this._loopEnd   = end
    window.api.engine.setLoop(this.deckId, start, end)
  }

  clearLoop(): void {
    this._looping = false
    window.api.engine.clearLoop(this.deckId)
  }

  get isLooping():  boolean { return this._looping   }
  get loopStart():  number  { return this._loopStart }
  get loopEnd():    number  { return this._loopEnd   }

  // ── EQ ───────────────────────────────────────────────────────────────────

  setEqGain(band: 'high' | 'mid' | 'low', db: number): void {
    if (band === 'high') this._eqHigh = db
    else if (band === 'mid') this._eqMid = db
    else this._eqLow = db
    window.api.engine.setEqGain(this.deckId, band, db)
  }

  get eqHighGain(): number { return this._eqHigh }
  get eqMidGain():  number { return this._eqMid  }
  get eqLowGain():  number { return this._eqLow  }

  // ── Pitch ────────────────────────────────────────────────────────────────

  set playbackRate(rate: number) {
    this._rate = Math.max(0.5, Math.min(2.0, rate))
    window.api.engine.setRate(this.deckId, this._rate)
  }
  get playbackRate(): number { return this._rate }

  set keylockEnabled(v: boolean) {
    this._keylock = v
    window.api.engine.setKeylock(this.deckId, v)
  }
  get keylockEnabled(): boolean { return this._keylock }

  // ── Volume ───────────────────────────────────────────────────────────────

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    window.api.engine.setVolume(this.deckId, this._volume)
  }
  get volume(): number { return this._volume }

  // ── Stems ────────────────────────────────────────────────────────────────

  setStemGain(kind: StemKind, db: number): void {
    window.api.engine.setStemGain(this.deckId, kind, db)
  }

  setStemMuted(kind: StemKind, muted: boolean): void {
    window.api.engine.setStemMuted(this.deckId, kind, muted)
  }

  setStemSoloed(kind: StemKind, soloed: boolean): void {
    window.api.engine.setStemSoloed(this.deckId, kind, soloed)
  }

  // ── Output routing ───────────────────────────────────────────────────────

  async setOutputDevice(deviceId: string): Promise<void> {
    await window.api.engine.setOutputDevice(this.deckId, deviceId)
  }

  // ── Inter-deck sync ──────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  syncTo(_master: AudioEngineContract): void {
    // TODO (Phase 4): send deckId pair to main process, Rust engine locks clocks
  }

  // ── Recording ────────────────────────────────────────────────────────────

  /** Native engine routes to hardware directly — no MediaStream available. */
  get recordingStream(): MediaStream | null { return null }

  // ── VU ───────────────────────────────────────────────────────────────────

  getLevel(): number {
    // Level is piggy-backed on every engine:timeUpdate event and cached here.
    // No IPC round-trip needed — safe to call from a RAF loop at 60fps.
    return this._lastLevel
  }

  // ── Events ───────────────────────────────────────────────────────────────

  onTimeUpdate(cb: TimeCallback): () => void {
    this.timeCbs.push(cb)
    return () => { this.timeCbs = this.timeCbs.filter((c) => c !== cb) }
  }

  onEnded(cb: VoidCallback): () => void {
    this.endCbs.push(cb)
    return () => { this.endCbs = this.endCbs.filter((c) => c !== cb) }
  }
}
