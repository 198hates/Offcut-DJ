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

const STEM_KINDS: StemKind[] = ['drums', 'bass', 'vocals', 'other']

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
      this.eqMid.Q.value = 0.9 // matches the native engine's mid band
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

      // Per-stem gain buses — each sums into the EQ chain (eqLow). When stems
      // are loaded, the four stem sources route through these instead of the
      // single main source.
      for (const k of STEM_KINDS) {
        const g = this.ctx.createGain()
        g.gain.value = 1
        g.connect(this.eqLow)
        this.stemGains[k] = g
      }

      // Chain: EQ → gain → analyser → speakers + record dest.
      // Pre-listen taps POST-EQ but PRE-FADER: cueing the next track must be
      // audible in headphones with the channel fader down — a post-fader tap
      // defeats the point of a cue bus.
      this.eqLow.connect(this.eqMid)
      this.eqMid.connect(this.eqHigh)
      this.eqHigh.connect(this.gainNode)
      this.eqHigh.connect(this._preListenGain)
      this.gainNode.connect(this.analyser)
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
    // A freshly loaded track starts on the single mix bus; stems (if any) are
    // loaded explicitly afterwards via loadStems().
    this.stemBuffers = null
    this._hasStems = false

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
    if (!this.gainNode) return
    if (!this._hasStems && !this.buffer) return
    const ctx = this.getCtx()
    cancelAnimationFrame(this.rafId)  // prevent stale RAF chains from accumulating
    this._stopSource()

    const pos = Math.max(0, Math.min(from ?? this.pausedAt, this.duration))
    this.startPos = pos
    this.startedAt = ctx.currentTime

    const onEnded = (): void => {
      if (this._playing) {
        this._playing = false
        this.pausedAt = 0
        this.endCbs.forEach((cb) => cb())
        cancelAnimationFrame(this.rafId)
      }
    }

    if (this._hasStems && this.stemBuffers) {
      // Four stem buses, started in the same synchronous block → sample-aligned.
      this.stemSources = {}
      let first = true
      for (const k of STEM_KINDS) {
        const src = ctx.createBufferSource()
        src.buffer = this.stemBuffers[k]
        src.playbackRate.value = this._rate
        if (this._looping && this._loopEnd > this._loopStart) {
          src.loop = true
          src.loopStart = this._loopStart
          src.loopEnd = this._loopEnd
        }
        src.connect(this.stemGains[k]!)
        if (first) {
          src.onended = onEnded
          first = false
        }
        src.start(0, pos)
        this.stemSources[k] = src
      }
      this._applyStemGains()
    } else {
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
      this.source.onended = onEnded
      this.source.start(0, pos)
    }

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

  // Scrub-while-paused (needle search) is a native-engine feature; the Web Audio
  // fallback doesn't render audio with the transport stopped, so these are no-ops.
  scrubBegin(): void {}
  scrubEnd(): void {}

  // ── Loop ──────────────────────────────────────────────────────────────────

  setLoop(start: number, end: number): void {
    this._loopStart = Math.max(0, start)
    this._loopEnd = Math.min(end, this.duration || end)
    this._looping = true
    const arm = (s: AudioBufferSourceNode | null | undefined): void => {
      if (!s) return
      s.loop = true
      s.loopStart = this._loopStart
      s.loopEnd = this._loopEnd
    }
    arm(this.source)
    for (const k of STEM_KINDS) arm(this.stemSources[k])
  }

  clearLoop(): void {
    this._looping = false
    if (this.source) this.source.loop = false
    for (const k of STEM_KINDS) {
      const s = this.stemSources[k]
      if (s) s.loop = false
    }
  }

  get isLooping(): boolean { return this._looping }
  get loopStart(): number { return this._loopStart }
  get loopEnd(): number { return this._loopEnd }

  // ── Playback rate ─────────────────────────────────────────────────────────

  set playbackRate(r: number) {
    this._rate = Math.max(0.5, Math.min(2.0, r))
    if (this.source) this.source.playbackRate.value = this._rate
    for (const k of STEM_KINDS) {
      const s = this.stemSources[k]
      if (s) s.playbackRate.value = this._rate
    }
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
    // Knob floor acts as a kill (full cut), matching the native engine; the
    // short time constant glides the change so fast knob moves don't zipper.
    const applied = clamped <= -23.9 ? -40 : clamped
    const apply = (f: BiquadFilterNode | null): void => {
      if (!f) return
      if (this.ctx) f.gain.setTargetAtTime(applied, this.ctx.currentTime, 0.03)
      else f.gain.value = applied
    }
    if (band === 'high') {
      this._eqHigh = clamped
      apply(this.eqHigh)
    } else if (band === 'mid') {
      this._eqMid = clamped
      apply(this.eqMid)
    } else {
      this._eqLow = clamped
      apply(this.eqLow)
    }
  }

  get eqHighGain(): number { return this._eqHigh }
  get eqMidGain():  number { return this._eqMid  }
  get eqLowGain():  number { return this._eqLow  }

  // ── FX (filter / delay) ──────────────────────────────────────────────────
  // Native-engine-only: the Web Audio fallback has no FX graph, so these no-op.
  // Automix transitions that use FX degrade to a plain crossfade on this engine.
  setFilter(_knob: number): void {}
  setDelay(_timeMs: number, _feedback: number, _mix: number, _enabled: boolean): void {}

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
  // Real per-stem buses: four decoded stem buffers, each played through its own
  // GainNode (created in getCtx, summed into the EQ chain). mute/solo/gain set
  // the corresponding GainNode, so they affect audio for real.

  private _stemGain:   Record<StemKind, number>  = { drums: 0, bass: 0, vocals: 0, other: 0 }
  private _stemMuted:  Record<StemKind, boolean> = { drums: false, bass: false, vocals: false, other: false }
  private _stemSoloed: Record<StemKind, boolean> = { drums: false, bass: false, vocals: false, other: false }

  private stemGains: Partial<Record<StemKind, GainNode>> = {}
  private stemBuffers: Record<StemKind, AudioBuffer> | null = null
  private stemSources: Partial<Record<StemKind, AudioBufferSourceNode>> = {}
  private _hasStems = false

  get hasStems(): boolean { return this._hasStems }

  setStemGain(kind: StemKind, db: number): void {
    this._stemGain[kind] = db
    this._applyStemGains()
  }
  setStemMuted(kind: StemKind, muted: boolean): void {
    this._stemMuted[kind] = muted
    this._applyStemGains()
  }
  setStemSoloed(kind: StemKind, soloed: boolean): void {
    this._stemSoloed[kind] = soloed
    this._applyStemGains()
  }

  /** Compute each stem's effective linear gain (mute / solo / trim) and apply it. */
  private _applyStemGains(): void {
    const anySolo = STEM_KINDS.some((k) => this._stemSoloed[k])
    for (const k of STEM_KINDS) {
      const g = this.stemGains[k]
      if (!g) continue
      const audible = !this._stemMuted[k] && (!anySolo || this._stemSoloed[k])
      const lin = audible ? Math.pow(10, this._stemGain[k] / 20) : 0
      const ctx = this.ctx
      if (ctx) g.gain.setTargetAtTime(lin, ctx.currentTime, 0.012)
      else g.gain.value = lin
    }
  }

  async loadStems(urls: Record<StemKind, string>): Promise<void> {
    const ctx = this.getCtx()
    const wasPlaying = this._playing
    const pos = this.currentTime
    const entries = await Promise.all(
      STEM_KINDS.map(async (k): Promise<[StemKind, AudioBuffer]> => {
        const src = urls[k]
        const ab =
          typeof src === 'string' && !/^https?:|^blob:/.test(src)
            ? await window.api.audio.readFile(src)
            : await (await fetch(src)).arrayBuffer()
        return [k, await ctx.decodeAudioData(ab.slice(0))]
      })
    )
    this.stemBuffers = Object.fromEntries(entries) as Record<StemKind, AudioBuffer>
    this._hasStems = true
    this._applyStemGains()
    // Re-arm playback on the stem buses if we were mid-play.
    this._stopSource()
    if (wasPlaying) this.play(pos)
    else this.pausedAt = pos
  }

  unloadStems(): void {
    const wasPlaying = this._playing
    const pos = this.currentTime
    this._stopSource()
    this.stemBuffers = null
    this._hasStems = false
    if (wasPlaying) this.play(pos)
    else this.pausedAt = pos
  }

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
   * Shared-clock sync is a native-engine feature (it derives the slave deck's
   * position from the master's transport in the Rust audio callback). The Web
   * Audio engine has no equivalent, so these are no-ops; callers should rely on
   * the native engine for beat-locked sync.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  syncTo(_masterId: string, _ratio: number, _phaseSeconds: number): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateSync(_ratio: number, _phaseSeconds: number): void {}
  clearSync(): void {}
  get isSynced(): boolean { return false }

  // ── Volume ────────────────────────────────────────────────────────────────

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    if (this.gainNode) {
      // Smooth fader moves (~6 ms) so rapid changes don't zipper — matches
      // the native engine's per-sample gain smoothing.
      if (this.ctx) this.gainNode.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.006)
      else this.gainNode.gain.value = this._volume
    }
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
    for (const k of STEM_KINDS) {
      const s = this.stemSources[k]
      if (s) {
        try { s.stop() } catch { /* already stopped */ }
        s.onended = null
      }
    }
    this.stemSources = {}
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
