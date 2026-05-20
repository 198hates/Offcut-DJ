export interface WaveformData {
  peaks: Float32Array
  detailPeaks: Float32Array
  lowPeaks: Float32Array    // bass  (20–300 Hz) — cream/white in 3-band mode
  midPeaks: Float32Array    // mids  (300–3000 Hz) — orange in 3-band mode
  highPeaks: Float32Array   // highs (3000–16000 Hz) — blue in 3-band mode
  duration: number
}

type TimeCallback = (time: number) => void
type VoidCallback = () => void

class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null

  // Playback tracking
  private startPos = 0            // buffer position when source last started
  private startedAt = 0           // ctx.currentTime when source last started
  private _playing = false

  // Settings that persist across play() calls
  private _volume = 0.8
  private _rate = 1.0
  private _looping = false
  private _loopStart = 0
  private _loopEnd = 0

  // Paused position
  private pausedAt = 0

  private rafId = 0
  private timeCbs: TimeCallback[] = []
  private endCbs: VoidCallback[] = []

  // ── Context ───────────────────────────────────────────────────────────────

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.gainNode = this.ctx.createGain()
      this.gainNode.gain.value = this._volume
      this.gainNode.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async load(arrayBuffer: ArrayBuffer): Promise<WaveformData> {
    const ctx = this.getCtx()
    this.stop()
    this._looping = false
    this._rate = 1.0
    this.buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
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

    this.source.connect(this.gainNode)
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

  // ── Volume ────────────────────────────────────────────────────────────────

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    if (this.gainNode) this.gainNode.gain.value = this._volume
  }
  get volume(): number { return this._volume }

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

  get duration(): number { return this.buffer?.duration ?? 0 }
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
