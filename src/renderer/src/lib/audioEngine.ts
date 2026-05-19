export interface WaveformData {
  peaks: Float32Array
  detailPeaks: Float32Array
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
    return {
      peaks: computePeaks(this.buffer, 1000),
      detailPeaks: computePeaks(this.buffer, 8000),
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

export { AudioEngine }
