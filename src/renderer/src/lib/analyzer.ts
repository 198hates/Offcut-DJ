import type { AnalyzerResult } from './analyzerWorker'

// Vite worker import — bundled separately, runs off-thread
import AnalyzerWorker from './analyzerWorker?worker'

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
