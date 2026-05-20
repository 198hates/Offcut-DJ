import type { AnalyzerResult, SuggestedCue } from './analyzerWorker'
import type { CuePoint } from '@shared/types'

// Vite worker import — bundled separately, runs off-thread
import AnalyzerWorker from './analyzerWorker?worker'

export type { SuggestedCue }

export async function analyzeAudio(buffer: AudioBuffer): Promise<AnalyzerResult> {
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

    // Mix down to mono Float32Array and transfer to the worker
    const mono = toMono(buffer)
    worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer])
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
export async function generateCuesForFile(filePath: string): Promise<CuePoint[]> {
  const ab          = await window.api.audio.readFile(filePath)
  const ctx         = new AudioContext()
  const audioBuffer = await ctx.decodeAudioData(ab)
  await ctx.close()
  const result      = await analyzeAudio(audioBuffer)
  return suggestedCuesToCuePoints(result.suggestedCues)
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
