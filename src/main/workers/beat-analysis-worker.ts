/**
 * Node.js worker_thread that runs the full beat analysis pipeline.
 * Runs on a separate OS thread so the main process (and its macOS run loop)
 * remains completely free — no spinning wheel during long analyses.
 */
import { workerData, parentPort } from 'worker_threads'
import { decodeAudioToPcm } from '../integrations/beat-analysis/audio-decode'
import { computeMelSpectrogram, MEL_CONFIG } from '../integrations/beat-analysis/mel-spectrogram'
import { runBeatAnalysis } from '../integrations/beat-analysis/beat-model'

interface WorkerInput {
  filePath: string
  modelPath: string
}

const { filePath, modelPath } = workerData as WorkerInput

async function run(): Promise<void> {
  try {
    const samples = await decodeAudioToPcm(filePath, MEL_CONFIG.sampleRate)
    const durationMs = (samples.length / MEL_CONFIG.sampleRate) * 1000

    const { data, numFrames } = await computeMelSpectrogram(samples)
    const markers = await runBeatAnalysis(data, numFrames, modelPath)

    const bpms = markers.map((m) => m.bpm).filter((b) => b > 40 && b < 300)
    const sortedBpms = [...bpms].sort((a, b) => a - b)
    const medianBpm = sortedBpms[Math.floor(sortedBpms.length / 2)] ?? 0
    const meanConf = markers.reduce((s, m) => s + (m.confidence ?? 1), 0) / (markers.length || 1)
    const barCount = markers.filter((m) => m.isDownbeat).length

    parentPort!.postMessage({
      success: true,
      markers,
      durationMs,
      detectedBpm: Math.round(medianBpm * 10) / 10,
      barCount,
      confidence: Math.round(meanConf * 1000) / 1000,
    })
  } catch (err) {
    parentPort!.postMessage({ success: false, error: (err as Error).message })
  }
}

run()
