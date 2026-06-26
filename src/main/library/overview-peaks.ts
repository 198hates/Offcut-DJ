/**
 * Per-track amplitude overview for the library mini-waveform.
 *
 * The deck computes full-resolution peaks on load, but the library can't spin
 * up the audio engine for thousands of rows. Instead we store a small (~128
 * bucket) normalised envelope per track — cheap to render, and a faithful
 * miniature of the deck's overview waveform.
 */
import { decodeAudioToPcm } from '../integrations/beat-analysis/audio-decode'

export const OVERVIEW_BUCKETS = 128

/** Max-abs amplitude per bucket from mono PCM, normalised 0–1 (rounded to 3dp). */
export function peaksFromPcm(pcm: ArrayLike<number>, buckets = OVERVIEW_BUCKETS): number[] {
  const out = new Array<number>(buckets).fill(0)
  if (pcm.length === 0) return out
  const per = pcm.length / buckets
  let max = 0
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per)
    const end = Math.min(pcm.length, Math.floor((b + 1) * per))
    let m = 0
    for (let i = start; i < end; i++) { const a = Math.abs(pcm[i]); if (a > m) m = a }
    out[b] = m
    if (m > max) max = m
  }
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] = Math.round((out[b] / max) * 1000) / 1000
  return out
}

/** Decode the file at a low sample rate (envelope only) and summarise it. */
export async function computeOverviewPeaks(filePath: string): Promise<number[]> {
  // 8 kHz mono is ample for an amplitude envelope and decodes fast.
  const pcm = await decodeAudioToPcm(filePath, 8000)
  return peaksFromPcm(pcm)
}
