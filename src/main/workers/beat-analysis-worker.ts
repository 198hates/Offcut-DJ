/**
 * Persistent beat-analysis worker.
 *
 * Stays alive for the lifetime of the app. The main process sends one
 * { filePath } message at a time and waits for the result before sending
 * the next — i.e. requests are serialised by the caller (index.ts).
 *
 * Loading the ONNX model once and keeping it resident eliminates:
 *   - Per-track model load cost (~100 MB disk I/O + native init each time)
 *   - ONNX global-state conflicts between the main-process warmModel()
 *     session and per-track worker sessions (the previous crash cause)
 *
 * If a native crash occurs (ONNX assertion / segfault), the worker process
 * dies. The main process detects the 'exit' event, restarts the worker for
 * the next track, and the Electron app is never affected.
 */
import { workerData, parentPort } from 'worker_threads'
import { decodeAudioToPcm } from '../integrations/beat-analysis/audio-decode'
import { computeMelSpectrogram, MEL_CONFIG } from '../integrations/beat-analysis/mel-spectrogram'
import { runBeatAnalysis } from '../integrations/beat-analysis/beat-model'

interface WorkerInit  { modelPath: string }
interface TrackRequest { filePath: string }

const { modelPath } = workerData as WorkerInit

async function analyseTrack(filePath: string): Promise<void> {
  const samples    = await decodeAudioToPcm(filePath, MEL_CONFIG.sampleRate)
  const durationMs = (samples.length / MEL_CONFIG.sampleRate) * 1000

  const { data, numFrames } = await computeMelSpectrogram(samples)
  const markers = await runBeatAnalysis(data, numFrames, modelPath)

  const bpms      = markers.map((m) => m.bpm).filter((b) => b > 40 && b < 300)
  const sorted    = [...bpms].sort((a, b) => a - b)
  const medianBpm = sorted[Math.floor(sorted.length / 2)] ?? 0
  const meanConf  = markers.reduce((s, m) => s + (m.confidence ?? 1), 0) / (markers.length || 1)
  const barCount  = markers.filter((m) => m.isDownbeat).length

  parentPort!.postMessage({
    success: true,
    markers,
    durationMs,
    detectedBpm: Math.round(medianBpm * 10) / 10,
    barCount,
    confidence: Math.round(meanConf * 1000) / 1000,
  })
}

// Pre-load the ONNX model as soon as the worker starts so the first real
// analysis request doesn't pay the cold-start cost.
// We import via the model module so the cached _session is populated.
import('../integrations/beat-analysis/beat-model')
  .then(({ runBeatAnalysis: _ }) => { /* module loaded, session will init on first call */ })
  .catch(() => { /* model file missing — will surface on first request */ })

parentPort!.on('message', async (req: TrackRequest) => {
  try {
    await analyseTrack(req.filePath)
  } catch (err) {
    parentPort!.postMessage({ success: false, error: (err as Error).message })
  }
})
