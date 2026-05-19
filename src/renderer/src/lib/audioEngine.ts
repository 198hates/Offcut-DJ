export interface WaveformData {
  peaks: Float32Array
  duration: number
}

type TimeCallback = (time: number) => void
type VoidCallback = () => void

class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  private startedAt = 0
  private pausedAt = 0
  private _playing = false
  private _volume = 0.8
  private rafId = 0
  private timeCbs: TimeCallback[] = []
  private endCbs: VoidCallback[] = []

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

  async load(arrayBuffer: ArrayBuffer): Promise<WaveformData> {
    const ctx = this.getCtx()
    this.stop()
    // decodeAudioData consumes the buffer — copy it first so caller keeps theirs
    this.buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
    this.pausedAt = 0
    return { peaks: computePeaks(this.buffer, 2000), duration: this.buffer.duration }
  }

  play(from?: number): void {
    if (!this.buffer || !this.gainNode) return
    const ctx = this.getCtx()
    this._stopSource()
    this.source = ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.gainNode)
    this.source.onended = () => {
      if (this._playing) {
        this._playing = false
        this.pausedAt = 0
        this.endCbs.forEach((cb) => cb())
        cancelAnimationFrame(this.rafId)
      }
    }
    const pos = from ?? this.pausedAt
    this.startedAt = ctx.currentTime - pos
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

  get currentTime(): number {
    if (!this.ctx) return 0
    return this._playing
      ? Math.min(this.ctx.currentTime - this.startedAt, this.buffer?.duration ?? 0)
      : this.pausedAt
  }

  get duration(): number { return this.buffer?.duration ?? 0 }
  get isPlaying(): boolean { return this._playing }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v))
    if (this.gainNode) this.gainNode.gain.value = this._volume
  }
  get volume(): number { return this._volume }

  onTimeUpdate(cb: TimeCallback): () => void {
    this.timeCbs.push(cb)
    return () => { this.timeCbs = this.timeCbs.filter((c) => c !== cb) }
  }
  onEnded(cb: VoidCallback): () => void {
    this.endCbs.push(cb)
    return () => { this.endCbs = this.endCbs.filter((c) => c !== cb) }
  }

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

export const audioEngine = new AudioEngine()
