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
    // A new track must never inherit the previous track's stem buses — the
    // Rust engine also clears them in load(); this keeps the JS cache honest
    // even if the load below fails partway.
    if (this._hasStems) this.unloadStems()
    const result = await window.api.engine.load(this.deckId, source)
    this._duration     = result.duration
    this._currentTime  = 0
    this._isPlaying    = false
    // Mirror the engine-side load resets (Rust clears looping and rate; the
    // Web engine does the same internally) so the cached getters don't lie.
    this._looping      = false
    this._loopStart    = 0
    this._loopEnd      = 0
    this._rate         = 1.0
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

  // NOTE: the contract is in seconds; the engine IPC + Rust work in milliseconds,
  // so every outgoing position/loop value is converted here (×1000). Incoming
  // time-updates are already converted to seconds by the main process.

  play(from?: number): void {
    window.api.engine.play(this.deckId, from === undefined ? undefined : from * 1000)
    this._isPlaying = true
  }

  pause(): void {
    window.api.engine.pause(this.deckId)
    this._isPlaying = false
  }

  seek(seconds: number): void {
    window.api.engine.seek(this.deckId, seconds * 1000)
    this._currentTime = seconds
  }

  scrubBegin(): void { window.api.engine.scrubBegin(this.deckId) }
  scrubEnd():   void { window.api.engine.scrubEnd(this.deckId) }

  get currentTime(): number { return this._currentTime }
  get duration():    number { return this._duration    }
  get isPlaying():   boolean { return this._isPlaying  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  setLoop(start: number, end: number): void {
    this._looping   = true
    this._loopStart = start
    this._loopEnd   = end
    window.api.engine.setLoop(this.deckId, start * 1000, end * 1000)
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

  // Real multi-bus stem playback: the four stem files are decoded in Rust and
  // mixed on independent buses, so setStemGain/Muted/Soloed affect audio. The
  // `urls` here are on-disk WAV paths (the native engine reads from disk).
  private _hasStems = false
  get hasStems(): boolean { return this._hasStems }

  async loadStems(urls: Record<StemKind, string>): Promise<void> {
    await window.api.engine.loadStems(this.deckId, urls)
    this._hasStems = true
  }

  unloadStems(): void {
    this._hasStems = false
    window.api.engine.unloadStems(this.deckId)
  }

  // ── Output routing ───────────────────────────────────────────────────────

  async setOutputDevice(deviceId: string): Promise<void> {
    await window.api.engine.setOutputDevice(this.deckId, deviceId)
  }

  // ── Inter-deck sync (shared clock) ─────────────────────────────────────────

  private _synced = false

  syncTo(masterId: string, ratio: number, phaseSeconds: number): void {
    this._synced = true
    window.api.engine.syncTo(this.deckId, masterId, ratio, phaseSeconds)
  }

  updateSync(ratio: number, phaseSeconds: number): void {
    window.api.engine.updateSync(this.deckId, ratio, phaseSeconds)
  }

  clearSync(): void {
    this._synced = false
    window.api.engine.clearSync(this.deckId)
  }

  get isSynced(): boolean { return this._synced }

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
