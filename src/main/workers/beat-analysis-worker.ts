/**
 * Persistent beat-analysis child process.
 *
 * Launched via child_process.fork() — a fully isolated OS process.
 * If ONNX crashes this process (SIGSEGV, abort), the parent is unaffected.
 *
 * Uses process.send / process.on('message') for IPC (standard fork API).
 * The ONNX model path is passed in process.env.BEAT_MODEL_PATH.
 * The model is loaded on first use and cached for the process lifetime.
 */
import { decodeAudioToPcm } from '../integrations/beat-analysis/audio-decode'
import { computeMelSpectrogram, MEL_CONFIG } from '../integrations/beat-analysis/mel-spectrogram'
import { runBeatAnalysis } from '../integrations/beat-analysis/beat-model'

const modelPath = process.env.BEAT_MODEL_PATH ?? ''

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

  process.send!({
    success: true,
    markers,
    durationMs,
    detectedBpm: Math.round(medianBpm * 10) / 10,
    barCount,
    confidence: Math.round(meanConf * 1000) / 1000,
  })
}

process.on('message', async (req: { filePath: string }) => {
  try {
    await analyseTrack(req.filePath)
  } catch (err) {
    process.send!({ success: false, error: (err as Error).message })
  }
})
