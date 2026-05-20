import { Worker } from 'worker_threads'
import { join } from 'path'
import { isModelAvailable, getDefaultModelPath, warmModel } from './beat-model'
import type { BeatgridMarker } from '../../../shared/types'

export { isModelAvailable, getDefaultModelPath, warmModel }

export interface BeatAnalysisResult {
  markers: BeatgridMarker[]
  durationMs: number
  detectedBpm: number
  barCount: number
  confidence: number
}

/**
 * Full pipeline: file path → BeatgridMarker[]
 *
 * Runs entirely in a worker_thread so the main process (and macOS run loop)
 * stays completely free — no spinning wheel regardless of track length.
 */
export function analyzeBeats(filePath: string): Promise<BeatAnalysisResult> {
  if (!isModelAvailable()) {
    throw new Error(`Beat analysis model not found. Place beat_this.onnx in: ${getDefaultModelPath()}`)
  }

  return new Promise((resolve, reject) => {
    // __dirname is out/main/ in both dev and production builds.
    // The worker is compiled to out/main/beat-analysis-worker.js by the vite config.
    const workerPath = join(__dirname, 'beat-analysis-worker.js')

    const worker = new Worker(workerPath, {
      workerData: {
        filePath,
        modelPath: getDefaultModelPath(),
      },
    })

    worker.once('message', (result: { success: true } & BeatAnalysisResult | { success: false; error: string }) => {
      if (result.success) resolve(result)
      else reject(new Error(result.error))
    })

    worker.once('error', reject)

    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Beat analysis worker exited with code ${code}`))
    })
  })
}
