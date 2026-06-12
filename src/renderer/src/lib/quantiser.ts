/**
 * quantiser.ts — Beatgrid v2 pipeline
 *
 * Phase 0: interfaces, helpers, and MockQuantiser.
 * Phase 1: BeatThisQuantiser (ONNX via IPC).
 * Phase 2: EssentiaQuantiser (Web Worker — spectral flux + DP beat tracker).
 *
 * The Quantiser interface lives in @shared/types.  This module re-exports
 * it for convenience and adds concrete implementations + conversion utilities.
 */

import type { Beat, Bar, Beatgrid, BeatgridMarker, Quantiser, QuantiserHints, TriageResult, Track } from '@shared/types'
import BeatTrackerWorker from './beatTrackerWorker?worker'
import type { BeatTrackerInput, BeatTrackerMessage } from './beatTrackerWorker'

export type { Quantiser, QuantiserHints, TriageResult }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns an empty (zero-beat) Beatgrid. Useful as a null-safe initialiser. */
export function emptyBeatgrid(source: Beatgrid['source'] = 'mock'): Beatgrid {
  return {
    beats: [],
    bars: [],
    downbeats: [],
    source,
    medianBpm: 0,
    firstBeatMs: 0,
    isConstantTempo: true,
    computedAt: new Date().toISOString()
  }
}

/**
 * Convert a legacy `BeatgridMarker[]` (flat beat list) into the richer
 * Beatgrid v2 struct.  Works with both constant-tempo and variable-tempo grids.
 *
 * @param markers   Sorted array of BeatgridMarker (ascending positionMs)
 * @param source    Where the markers came from
 */
export function fromBeatgridMarkers(
  markers: BeatgridMarker[],
  source: Beatgrid['source'] = 'tags'
): Beatgrid {
  if (markers.length === 0) return emptyBeatgrid(source)

  // Sort ascending (defensive)
  const sorted = [...markers].sort((a, b) => a.positionMs - b.positionMs)

  // ── Beats with beatInBar ───────────────────────────────────────────────────
  // The legacy format stores `isDownbeat` to mark bar 1.  Walk the list and
  // assign beatInBar 0–3 by counting from each downbeat.
  const beats: Beat[] = []
  let beatInBar = 0

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i]

    // Reset counter on every explicit downbeat.
    if (m.isDownbeat) beatInBar = 0

    beats.push({
      positionMs: m.positionMs,
      beatInBar: beatInBar % 4,
      confidence: m.confidence ?? 1.0
    })

    beatInBar++
  }

  // ── Bars ──────────────────────────────────────────────────────────────────
  // A bar starts at each beat where beatInBar === 0.
  const bars: Bar[] = []
  const downbeats: number[] = []
  let barIndex = 0

  for (let i = 0; i < beats.length; i++) {
    if (beats[i].beatInBar === 0) {
      // Instantaneous BPM at bar start: use interval to next beat if available
      let bpm = sorted[i].bpm
      if (i + 1 < sorted.length) {
        const intervalMs = sorted[i + 1].positionMs - sorted[i].positionMs
        if (intervalMs > 0) bpm = 60000 / intervalMs
      }

      bars.push({ positionMs: beats[i].positionMs, bpm, barIndex })
      downbeats.push(beats[i].positionMs)
      barIndex++
    }
  }

  // ── medianBpm ─────────────────────────────────────────────────────────────
  const allBpms = sorted.map((m) => m.bpm).filter((b) => b > 0)
  const medianBpm = allBpms.length > 0 ? median(allBpms) : 0

  // ── isConstantTempo ───────────────────────────────────────────────────────
  // True when every marker reports the same BPM within ±0.5 BPM tolerance.
  const isConstantTempo =
    allBpms.length === 0 ||
    Math.max(...allBpms) - Math.min(...allBpms) <= 0.5

  return {
    beats,
    bars,
    downbeats,
    source,
    medianBpm,
    firstBeatMs: sorted[0].positionMs,
    isConstantTempo,
    computedAt: new Date().toISOString()
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// ── MockQuantiser ─────────────────────────────────────────────────────────────
/**
 * Returns a synthetic beatgrid for any track.
 * Uses the track's stored BPM (or 128 BPM default) to generate a constant-
 * tempo grid.  Useful for unit tests and UI development without a real model.
 *
 * Triage always returns canAnalyse: true.
 * Analysis simulates a 200 ms processing delay per second of audio.
 */
export class MockQuantiser implements Quantiser {
  async triage(_track: Track, _hints?: QuantiserHints): Promise<TriageResult> {
    return { canAnalyse: true, estimatedMs: 100 }
  }

  async analyse(
    track: Track,
    hints?: QuantiserHints,
    onProgress?: (p: number) => void
  ): Promise<Beatgrid> {
    const bpm = hints?.bpmHint ?? track.bpm ?? 128
    const durationMs = (track.durationSeconds ?? 120) * 1000
    const beatMs = 60000 / bpm

    // Simulate progress in 10 chunks
    const steps = 10
    for (let i = 0; i < steps; i++) {
      await sleep(20)
      onProgress?.((i + 1) / steps)
    }

    // Build markers
    const markers: BeatgridMarker[] = []
    let t = 0
    let beatIdx = 0
    while (t <= durationMs) {
      markers.push({
        positionMs: Math.round(t),
        bpm,
        isDownbeat: beatIdx % 4 === 0,
        confidence: 0.95
      })
      t += beatMs
      beatIdx++
    }

    return fromBeatgridMarkers(markers, 'mock')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── BeatThisQuantiser ─────────────────────────────────────────────────────────
/**
 * Production quantiser: wraps the Beat This! ONNX child-process pipeline
 * already wired up in the main process (`library:analyzeBeats` IPC).
 *
 * `triage()` checks model availability via IPC.
 * `analyse()` calls `analyzeBeats`, converts the legacy BeatgridMarker[]
 *   result to Beatgrid v2, persists it, and returns it.
 */
export class BeatThisQuantiser implements Quantiser {
  async triage(track: Track, _hints?: QuantiserHints): Promise<TriageResult> {
    const status = await window.api.library.beatModelStatus()
    if (!status.available) {
      return {
        canAnalyse: false,
        reason: `Beat This! model not found. Run scripts/export-beat-this.py, then place beat_this.onnx at: ${status.path}`
      }
    }
    // Rough estimate: ~200 ms per second of audio through the ONNX pipeline
    const estimatedMs = track.durationSeconds
      ? Math.round(track.durationSeconds * 200)
      : undefined
    return { canAnalyse: true, estimatedMs }
  }

  async analyse(
    track: Track,
    _hints?: QuantiserHints,
    onProgress?: (p: number) => void
  ): Promise<Beatgrid> {
    // Signal that we're enqueued; actual model progress isn't streamed yet
    onProgress?.(0.05)

    // `analyzeBeats` runs the child process, saves the legacy `beatgrid`
    // column, and returns the updated Track with the new markers.
    const updated = await window.api.library.analyzeBeats(track.id)

    onProgress?.(0.85)

    // Convert to v2 struct
    const sorted = [...updated.beatgrid].sort((a, b) => a.positionMs - b.positionMs)
    const beatgrid = fromBeatgridMarkers(sorted, 'beat-this')

    // Persist v2 alongside the legacy markers
    await window.api.library.updateTrack({ id: track.id, analysedBeatgrid: beatgrid })

    onProgress?.(1.0)
    return beatgrid
  }
}

// ── EssentiaQuantiser ─────────────────────────────────────────────────────────
/**
 * JS-only fallback quantiser — no ONNX model required.
 *
 * Uses a dedicated Web Worker (`beatTrackerWorker.ts`) that implements:
 *   1. Spectral flux onset strength  (1024-pt FFT, 23 ms hop)
 *   2. Autocorrelation tempo estimation
 *   3. DP beat tracker  (Ellis-style, Gaussian transition cost)
 *   4. Downbeat detection via 4-beat phase scoring
 *
 * Accuracy is lower than Beat This! for irregular-tempo material but is
 * perfectly accurate for constant-tempo dance music and handles tempo hints.
 */
export class EssentiaQuantiser implements Quantiser {
  async triage(_track: Track, _hints?: QuantiserHints): Promise<TriageResult> {
    // No external deps — always available.  Rough estimate: ~500 ms per minute.
    return {
      canAnalyse: true,
      estimatedMs: _track.durationSeconds
        ? Math.round(_track.durationSeconds * 500 / 60)
        : 10000
    }
  }

  async analyse(
    track: Track,
    hints?: QuantiserHints,
    onProgress?: (p: number) => void
  ): Promise<Beatgrid> {
    onProgress?.(0.02)

    // Read + decode audio
    const ab  = await window.api.audio.readFile(track.filePath)
    onProgress?.(0.10)

    // try/finally — a decode failure must still close the context (Chromium
    // caps live AudioContexts; leaking them broke analysis + preview playback
    // after enough corrupt files in a batch).
    const ctx = new AudioContext()
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(ab)
    } finally {
      void ctx.close()
    }
    onProgress?.(0.20)

    // Mix to mono Float32Array
    const mono = toMono(buffer)

    // Run the DP beat tracker in a Web Worker
    const markers = await runBeatTrackerWorker(mono, buffer.sampleRate, {
      bpmHint: hints?.bpmHint ?? track.bpm ?? undefined,
      onProgress: (p) => onProgress?.(0.20 + p * 0.70)   // maps worker [0,1] → [0.20, 0.90]
    })

    onProgress?.(0.92)

    const beatgrid = fromBeatgridMarkers(markers, 'essentia')

    // Persist v2 struct
    await window.api.library.updateTrack({ id: track.id, analysedBeatgrid: beatgrid })

    onProgress?.(1.0)
    return beatgrid
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const out = new Float32Array(buffer.length)
  const inv = 1 / buffer.numberOfChannels
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const ch_data = buffer.getChannelData(ch)
    for (let i = 0; i < out.length; i++) out[i] += ch_data[i] * inv
  }
  return out
}

function runBeatTrackerWorker(
  samples: Float32Array,
  sampleRate: number,
  opts: { bpmHint?: number; onProgress?: (p: number) => void }
): Promise<BeatgridMarker[]> {
  return new Promise((resolve, reject) => {
    const worker = new BeatTrackerWorker()

    worker.onmessage = ({ data }: MessageEvent<BeatTrackerMessage>) => {
      if (data.type === 'progress') {
        opts.onProgress?.(data.pct)
      } else if (data.type === 'result') {
        worker.terminate()
        resolve(data.markers as BeatgridMarker[])
      } else {
        worker.terminate()
        reject(new Error(data.message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(new Error(err.message))
    }

    const input: BeatTrackerInput = {
      samples,
      sampleRate,
      bpmHint: opts.bpmHint
    }
    // Transfer the ArrayBuffer to avoid copying 20–100 MB of audio data
    worker.postMessage(input, [samples.buffer])
  })
}

// ── Singleton accessor ────────────────────────────────────────────────────────
// The active quantiser used by the player and Analyse page.
// Call `initQuantiser()` once on app startup; thereafter `getQuantiser()` is sync.

let _quantiser: Quantiser | null = null

export function getQuantiser(): Quantiser {
  if (!_quantiser) _quantiser = new MockQuantiser()
  return _quantiser
}

export function setQuantiser(q: Quantiser): void {
  _quantiser = q
}

/**
 * Check model availability and install the best available quantiser.
 * Priority: BeatThisQuantiser (ONNX) > EssentiaQuantiser (JS) > MockQuantiser
 * Safe to call multiple times; no-ops once a real quantiser is installed.
 */
export async function initQuantiser(): Promise<void> {
  // No-op if already using a real (non-mock) quantiser
  if (_quantiser && !(_quantiser instanceof MockQuantiser)) return
  try {
    const status = await window.api.library.beatModelStatus()
    _quantiser = status.available ? new BeatThisQuantiser() : new EssentiaQuantiser()
  } catch {
    _quantiser = new EssentiaQuantiser()
  }
}
