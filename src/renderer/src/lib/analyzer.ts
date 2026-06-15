import type { AnalyzerResult, SuggestedCue } from './analyzerWorker'
import type { CuePoint } from '@shared/types'

// Vite worker import — bundled separately, runs off-thread
import AnalyzerWorker from './analyzerWorker?worker'

export type { SuggestedCue }

/**
 * Decode a track to an AudioBuffer, robustly.
 *
 * The renderer's Web Audio `decodeAudioData` throws "EncodingError" on formats
 * DJs routinely use (FLAC, AIFF, ALAC/.m4a). When it fails we fall back to the
 * main-process ffmpeg decoder (mono PCM) and wrap that in an AudioBuffer, so
 * analysis/auto-cue work on every format instead of silently producing nothing.
 */
export async function decodeTrackToBuffer(filePath: string, ctx: AudioContext): Promise<AudioBuffer> {
  const ab = await window.api.audio.readFile(filePath)
  try {
    return await ctx.decodeAudioData(ab)
  } catch {
    const { samples, sampleRate } = await window.api.audio.decodePcm(filePath)
    const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate)
    buf.getChannelData(0).set(samples)
    return buf
  }
}

export async function analyzeAudio(buffer: AudioBuffer, bars?: number[]): Promise<AnalyzerResult> {
  return new Promise((resolve, reject) => {
    const worker = new AnalyzerWorker()

    worker.onmessage = (e: MessageEvent<AnalyzerResult>) => {
      worker.terminate()
      resolve(e.data)
    }
    worker.onerror = (err) => {
      worker.terminate()
      reject(new Error(err.message))
    }

    // Mix down to mono Float32Array and transfer to the worker. `bars` (real
    // downbeats, ms) anchors the structural cues to true bars when available.
    const mono = toMono(buffer)
    worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate, bars }, [mono.buffer])
  })
}

/**
 * Run just the structural cue analysis for a track.
 * Decodes the raw audio bytes, runs the full worker (BPM + structural cues),
 * and returns CuePoint[] ready to store.  Uses indices 0–3 for the 4 cue slots.
 *
 * @param filePath – native file path (used only to read via Electron API)
 * @param existingBpm – if provided, used only as a hint; analysis always runs in full
 */
export async function generateCuesForFile(filePath: string, bars?: number[]): Promise<CuePoint[]> {
  const ctx = new AudioContext()
  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await decodeTrackToBuffer(filePath, ctx)
  } finally {
    // Close even on decode failure — leaked AudioContexts eventually make
    // `new AudioContext()` fail renderer-wide.
    void ctx.close()
  }
  const result = await analyzeAudio(audioBuffer, bars)
  return suggestedCuesToCuePoints(result.suggestedCues)
}

/** The real downbeat positions (ms) for a track — analysed grid first, then any
 *  downbeat markers, else none (cue generation falls back to a derived grid). */
export function downbeatsForTrack(t: {
  analysedBeatgrid?: { downbeats?: number[] } | null
  beatgrid?: { positionMs: number; isDownbeat?: boolean }[]
}): number[] | undefined {
  const fromAnalysed = t.analysedBeatgrid?.downbeats
  if (fromAnalysed && fromAnalysed.length >= 8) return fromAnalysed
  const fromMarkers = (t.beatgrid ?? []).filter((m) => m.isDownbeat).map((m) => m.positionMs)
  return fromMarkers.length >= 8 ? fromMarkers : undefined
}

/** Map SuggestedCue[] → CuePoint[] (hotcues, indices 0-N) */
export function suggestedCuesToCuePoints(suggested: SuggestedCue[]): CuePoint[] {
  return suggested.map((c, i) => ({
    index: i,
    type: 'hotcue' as const,
    positionMs: c.positionMs,
    color: c.color,
    label: c.label,
  }))
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice()
  }
  const out = new Float32Array(buffer.length)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) out[i] += data[i]
  }
  const inv = 1 / buffer.numberOfChannels
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return out
}

/**
 * RMS-based loudness analysis.
 * Returns the gain (in dB) needed to normalise this track to `targetLufs` dBFS.
 * Uses a simplified RMS approach — not full ITU-R BS.1770 LUFS but close enough
 * for auto-gain normalisation in a DJ context (±1 dB accuracy).
 *
 * @param buffer     Decoded audio buffer
 * @param targetLufs Target loudness in dBFS (default −14 dBFS = streaming standard)
 * @returns gainDb — positive means boost, negative means cut; 0 if signal is silent
 */
export function computeRmsGainDb(buffer: AudioBuffer, targetLufs = -14): number {
  const mono = toMono(buffer)
  let sum = 0
  // Skip first + last 0.5s to avoid DC offsets and fade-outs affecting the reading
  const skip = Math.floor(buffer.sampleRate * 0.5)
  const start = Math.min(skip, Math.floor(mono.length * 0.05))
  const end   = Math.max(mono.length - skip, Math.floor(mono.length * 0.95))
  let count   = 0
  for (let i = start; i < end; i++) {
    sum += mono[i] * mono[i]
    count++
  }
  if (count === 0 || sum === 0) return 0
  const rms  = Math.sqrt(sum / count)
  const dbFs = 20 * Math.log10(rms)
  // Clamp gainDb to ±12 dB to prevent extreme corrections
  return Math.max(-12, Math.min(12, targetLufs - dbFs))
}
