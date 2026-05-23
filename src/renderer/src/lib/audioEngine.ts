/**
 * Web Audio API engine — implements AudioEngineContract for the renderer process.
 *
 * Stays as the default runtime engine until the native Rust engine (id·2026·009)
 * is compiled and shipped. The two engines are swappable behind the shared interface.
 */

import type { AudioEngineContract, LoadResult } from './audioEngineContract'
import type { StemKind } from '@shared/types'

// Re-export LoadResult so callers that previously imported WaveformData can migrate.
export type { LoadResult }
/** @deprecated Use LoadResult from audioEngineContract.ts */
export type WaveformData = LoadResult

type TimeCallback = (time: number) => void
type VoidCallback = () => void

class AudioEngine implements AudioEngineContract {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null

  // 3-band EQ (insert before gain)
  private eqLow:  BiquadFilterNode | null = null   // low shelf  ~200 Hz
  private eqMid:  BiquadFilterNode | null = null   // peaking    ~1 kHz
  private eqHigh: BiquadFilterNode | null = null   // high shelf ~8 kHz

  // Post-fader analyser for VU metering
  private analyser:     AnalyserNode | null = null
  private analyserBuf:  Float32Array        = new Float32Array(256)

  // Recording output node — connect to MediaRecorder stream
  private _recordDest: MediaStreamAudioDestinationNode | null = null
  // Pre-listen output node — connect to a second AudioContext for cue output
  private _preListenGain: GainNode | null = null

  // Playback tracking
  private startPos = 0
  private startedAt = 0
  private _playing = false

  // Settings that persist across play() calls
  private _volume = 0.8
  private _rate = 1.0
  private _looping = false
  private _loopStart = 0
  private _loopEnd = 0
  private _eqLow  = 0   // dB
  private _eqMid  = 0
  private _eqHigh = 0

  // Paused position
  private pausedAt = 0

  private rafId = 0
  private timeCbs: TimeCallback[] = []
  private endCbs: VoidCallback[] = []

  // ── Context ───────────────────────────────────────────────────────────────

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()

      // EQ filters
      this.eqLow = this.ctx.createBiquadFilter()
      this.eqLow.type = 'lowshelf'
      this.eqLow.frequency.value = 200
      this.eqLow.gain.value = this._eqLow

      this.eqMid = this.ctx.createBiquadFilter()
      this.eqMid.type = 'peaking'
      this.eqMid.frequency.value = 1000
      this.eqMid.Q.value = 0.8
      this.eqMid.gain.value = this._eqMid

      this.eqHigh = this.ctx.createBiquadFilter()
      this.eqHigh.type = 'highshelf'
      this.eqHigh.frequency.value = 8000
      this.eqHigh.gain.value = this._eqHigh

      // Gain (channel fader × crossfader)
      this.gainNode = this.ctx.createGain()
      this.gainNode.gain.value = this._volume

      // Post-fader analyser for VU meter
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.65
      this.analyserBuf = new Float32Array(this.analyser.fftSize)

      // Pre-listen gain (starts at 0 — only raised when cue is enabled)
      this._preListenGain = this.ctx.createGain()
      this._preListenGain.gain.value = 0

      // Recording destination (MediaRecorder can attach its stream here)
      this._recordDest = this.ctx.createMediaStreamDestination()

      // Chain: EQ → gain → analyser → speakers + record dest
      this.eqLow.connect(this.eqMid)
      this.eqMid.connect(this.eqHigh)
      this.eqHigh.connect(this.gainNode)
      this.gainNode.connect(this.analyser)
      this.gainNode.connect(this._preListenGain)
      this.gainNode.connect(this._recordDest)
      this.analyser.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(source: string | ArrayBuffer): Promise<LoadResult> {
    const ctx = this.getCtx()
    this.stop()
    this._looping = false
    this._rate = 1.0

    let ab: ArrayBuffer
    if (typeof source === 'string') {
      // File path — read via IPC (renderer cannot access fs directly)
      ab = await window.api.audio.readFile(source)
    } else {
      ab = source
    }

    this.buffer = await ctx.decodeAudioData(ab.slice(0))
    this.pausedAt = 0
    const { lowPeaks, midPeaks, highPeaks } = computeBandPeaks(this.buffer, 8000)
    return {
      peaks: computePeaks(this.buffer, 1000),
      detailPeaks: computePeaks(this.buffer, 8000),
      lowPeaks,
      midPeaks,
      highPeaks,
      duration: this.buffer.duration
    }
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  play(from?: number): void {
    if (!this.buffer || !this.gainNode) return
    const ctx = this.getCtx()
    cancelAnimationFrame(this.rafId)  // prevent stale RAF chains from accumulating
    this._stopSource()

    const pos = Math.max(0, Math.min(from ?? this.pausedAt, this.buffer.duration))
    this.startPos = pos
    this.startedAt = ctx.currentTime

    this.source = ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.playbackRate.value = this._rate

    if (this._looping && this._loopEnd > this._loopStart) {
      this.source.loop = true
      this.source.loopStart = this._loopStart
      this.source.loopEnd = this._loopEnd
    }

    // Route through EQ chain (eqLow is guaranteed to exist after getCtx())
    this.source.connect(this.eqLow!)
    this.source.onended = () => {
      if (this._playing) {
        this._playing = false
        this.pausedAt = 0
        this.endCbs.forEach((cb) => cb())
        cancelAnimationFrame(this.rafId)
      }
    }
    this.source.start(0, pos)
    this._playing = true
    this._tick()
  }

  pause(): void {
    if (!this._playing) return
    this.pausedAt = this.currentTime
    this._stopSource()
    this._playing = false
    cancelAnimationFrame(this.rafId)
  }

  stop(): void {
    this._stopSource()
    this._playing = false
    this.pausedAt = 0
    cancelAnimationFrame(this.rafId)
  }

  seek(time: number): void {
    const t = Math.max(0, Math.min(time, this.buffer?.duration ?? 0))
    if (this._playing) {
      this.play(t)
    } else {
      this.pausedAt = t
      this.timeCbs.forEach((cb) => cb(t))
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  setLoop(start: number, end: number): void {
    this._loopStart = Math.max(0, start)
    this._loopEnd = Math.min(end, this.buffer?.duration ?? end)
    this._looping = true
    if (this.source) {
      this.source.loop = true
      this.source.loopStart = this._loopStart
      this.source.loopEnd = this._loopEnd
    }
  }

  clearLoop(): void {
    this._looping = false
    if (this.source) this.source.loop = false
  }

  get isLooping(): boolean { return this._looping }
  get loopStart(): number { return this._loopStart }
  get loopEnd(): number { return this._loopEnd }

  // ── Playback rate ─────────────────────────────────────────────────────────

  set playbackRate(r: number) {
    this._rate = Math.max(0.5, Math.min(2.0, r))
    if (this.source) this.source.playbackRate.value = this._rate
    // Recalculate startedAt so currentTime stays continuous
    if (this._playing && this.ctx) {
      const t = this.currentTime
      this.startPos = t
      this.startedAt = this.ctx.currentTime
    }
  }
  get playbackRate(): number { return this._rate }

  // ── EQ ────────────────────────────────────────────────────────────────────
  // Range: −18 dB (kill) to +6 dB (boost). Clamped here; BiquadFilterNode
  // can handle values outside this but extremes sound bad.

  setEqGain(band: 'high' | 'mid' | 'low', db: number): void {
    const clamped = Math.max(-24, Math.min(6, db))
    if (band === 'high') {
      this._eqHigh = clamped
      if (this.eqHigh) this.eqHigh.gain.value = clamped
    } else if (band === 'mid') {
      this._eqMid = clamped
      if (this.eqMid) this.eqMid.gain.value = clamped
    } else {
      this._eqLow = clamped
      if (this.eqLow) this.eqLow.gain.value = clamped
    }
  }

  get eqHighGain(): number { return this._eqHigh }
  get eqMidGain():  number { return this._eqMid  }
  get eqLowGain():  number { return this._eqLow  }

  // ── VU level (post-fader RMS, 0–1 linear) ────────────────────────────────

  getLevel(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.analyserBuf as Float32Array<ArrayBuffer>)
    let sum = 0
    for (let i = 0; i < this.analyserBuf.length; i++) {
      sum += this.analyserBuf[i] * this.analyserBuf[i]
    }
    return Math.sqrt(sum / this.analyserBuf.length)
  }

  // ── Keylock ───────────────────────────────────────────────────────────────

  private _keylock = false

  /**
   * Enable keylock (pitch-preserving tempo change).
   * Web Audio fallback: stored but not yet applied — wired in Phase 2 via
   * AudioWorklet + RubberBand WASM when the native engine is not loaded.
   */
  set keylockEnabled(v: boolean) { this._keylock = v }
  get keylockEnabled(): boolean { return this._keylock }

  // ── Stems ─────────────────────────────────────────────────────────────────

  /**
   * Stem bus controls (drums / bass / vocals / other).
   * Pre-demucs: stored but not routed — all audio is on the main bus.
   * Post-demucs (Phase 3): each stem will have its own GainNode bus.
   */
  private _stemGain:   Record<StemKind, number>  = { drums: 0, bass: 0, vocals: 0, other: 0 }
  private _stemMuted:  Record<StemKind, boolean> = { drums: false, bass: false, vocals: false, other: false }
  private _stemSoloed: Record<StemKind, boolean> = { drums: false, bass: false, vocals: false, other: false }

  setStemGain(kind: StemKind, db: number): void   { this._stemGain[kind]   = db   }
  setStemMuted(kind: StemKind, muted: boolean):    void { this._stemMuted[kind]  = muted  }
  setStemSoloed(kind: StemKind, soloed: boolean):  void { this._stemSoloed[kind] = soloed }

  // ── Output routing ────────────────────────────────────────────────────────

  /**
   * Route this deck to a specific audio output device.
   * Web Audio: uses AudioContext.setSinkId() where supported.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    const ctx = this.getCtx()
    // AudioContext.setSinkId() is a newer API; cast through unknown for safety.
    const ctxAny = ctx as unknown as { setSinkId?: (id: string) => Promise<void> }
    if (typeof ctxAny.setSinkId === 'function') {
      await ctxAny.setSinkId(deviceId)
    }
    // Silently ignore on browsers / Electron versions that don't support setSinkId yet.
  }

  // ── Inter-deck sync ───────────────────────────────────────────────────────

  /**
   * Lock this deck's tempo to a master engine.
   * Stub — Phase 4: implemented once both decks share a Rust clock.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  syncTo(_master: AudioEngineContract): void {
    // TODO (Phase 4): adjust playbackRate to match master BPM and align phase
  }

  // ── Volume ────────────────────────────────────────────────────────────────

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    if (this.gainNode) this.gainNode.gain.value = this._volume
  }
  get volume(): number { return this._volume }

  /** Set pre-listen (cue) gain (0 = off, 1 = full) */
  set preListenGain(v: number) {
    if (this._preListenGain) this._preListenGain.gain.value = Math.max(0, Math.min(1, v))
  }

  /** Connect a pre-listen destination node (e.g. from a second AudioContext) */
  connectPreListen(dest: AudioNode): void {
    this._preListenGain?.connect(dest)
  }

  /** The MediaStream for recording this deck's output */
  get recordingStream(): MediaStream | null {
    return this._recordDest?.stream ?? null
  }

  // ── Time ─────────────────────────────────────────────────────────────────

  get currentTime(): number {
    if (!this.ctx || !this._playing) return this.pausedAt
    let t = this.startPos + (this.ctx.currentTime - this.startedAt) * this._rate
    // Wrap within loop region so UI position stays accurate
    if (this._looping && this._loopEnd > this._loopStart) {
      const len = this._loopEnd - this._loopStart
      if (t > this._loopEnd) {
        t = this._loopStart + ((t - this._loopStart) % len)
      }
    }
    return Math.min(t, this.buffer?.duration ?? t)
  }

  get duration(): number  { return this.buffer?.duration ?? 0 }
  get isPlaying(): boolean { return this._playing }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onTimeUpdate(cb: TimeCallback): () => void {
    this.timeCbs.push(cb)
    return () => { this.timeCbs = this.timeCbs.filter((c) => c !== cb) }
  }
  onEnded(cb: VoidCallback): () => void {
    this.endCbs.push(cb)
    return () => { this.endCbs = this.endCbs.filter((c) => c !== cb) }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _stopSource(): void {
    if (this.source) {
      try { this.source.stop() } catch { /* already stopped */ }
      this.source.onended = null
      this.source = null
    }
  }

  private _tick = (): void => {
    this.timeCbs.forEach((cb) => cb(this.currentTime))
    if (this._playing) this.rafId = requestAnimationFrame(this._tick)
  }
}

function computePeaks(buf: AudioBuffer, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets)
  const spb = buf.length / buckets
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < buckets; i++) {
      const s = Math.floor(i * spb)
      const e = Math.floor((i + 1) * spb)
      let max = 0
      for (let j = s; j < e; j++) {
        const a = Math.abs(data[j])
        if (a > max) max = a
      }
      if (max > peaks[i]) peaks[i] = max
    }
  }
  return peaks
}

// ── Frequency-band peak extraction (IIR envelope follower) ───────────────────
// First-order IIR lowpass applied to the rectified signal acts as a band
// splitter. O(N) — ~15ms for a 6-min track. Returns 8000-bucket arrays so the
// detail waveform has smooth per-pixel resolution.

function computeBandPeaks(buf: AudioBuffer, buckets: number): {
  lowPeaks: Float32Array; midPeaks: Float32Array; highPeaks: Float32Array
} {
  const sr = buf.sampleRate
  // Cutoff ~300 Hz (bass/mid split) and ~3000 Hz (mid/high split)
  const aLow  = 1 - Math.exp(-2 * Math.PI * 300  / sr)
  const aHigh = 1 - Math.exp(-2 * Math.PI * 3000 / sr)
  const bLow  = 1 - aLow
  const bHigh = 1 - aHigh

  // Mix to mono
  const len = buf.length
  const mono = new Float32Array(len)
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) mono[i] += d[i]
  }
  if (buf.numberOfChannels > 1) {
    const inv = 1 / buf.numberOfChannels
    for (let i = 0; i < len; i++) mono[i] *= inv
  }

  const lowBuf  = new Float32Array(buckets)
  const midBuf  = new Float32Array(buckets)
  const highBuf = new Float32Array(buckets)
  const spb = len / buckets

  let yLow = 0, yHigh = 0

  for (let i = 0; i < len; i++) {
    const x = Math.abs(mono[i])
    yLow  = aLow  * x + bLow  * yLow
    yHigh = aHigh * x + bHigh * yHigh

    const b       = Math.min(buckets - 1, Math.floor(i / spb))
    const bassVal = yLow
    const midsVal = Math.max(0, yHigh - yLow)
    const highVal = Math.max(0, x - yHigh)

    if (bassVal > lowBuf[b])  lowBuf[b]  = bassVal
    if (midsVal > midBuf[b])  midBuf[b]  = midsVal
    if (highVal > highBuf[b]) highBuf[b] = highVal
  }

  const norm = (a: Float32Array): void => {
    let max = 0
    for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i]
    if (max > 0) { const inv = 1 / max; for (let i = 0; i < a.length; i++) a[i] *= inv }
  }
  norm(lowBuf); norm(midBuf); norm(highBuf)

  return { lowPeaks: lowBuf, midPeaks: midBuf, highPeaks: highBuf }
}

export { AudioEngine }
