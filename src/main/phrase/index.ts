/**
 * Phrase / song-structure detection via `all-in-one` (allin1) — MAIN process.
 *
 * Shells out to Python (mirrors the Demucs stems sidecar). The all-in-one model
 * returns functional segments (intro/verse/chorus/bridge/break/…); we map those
 * onto Offcut's PhraseLabel union. Opt-in: requires `pip install allin1` in the
 * configured Python. Results are small JSON, so the library DB is the cache —
 * the renderer only requests detection for tracks whose `phrases` is null.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { PhraseLabel, PhraseSegment } from '../../shared/types'

// all-in-one functional labels → Offcut PhraseLabel. Buildup/drop aren't emitted
// by the structure model (they come from Rekordbox phrase data on import).
const LABEL_MAP: Record<string, PhraseLabel> = {
  intro: 'intro',
  verse: 'verse',
  chorus: 'chorus',
  bridge: 'bridge',
  inst: 'verse',
  break: 'breakdown',
  solo: 'bridge',
  outro: 'outro'
}

// One self-contained Python program — avoids shipping/locating a script file.
const SCRIPT = `
import sys, json, os, tempfile, shutil
import allin1
tmp = tempfile.mkdtemp()
try:
    r = allin1.analyze(sys.argv[1], out_dir=tmp,
                       demix_dir=os.path.join(tmp, 'demix'),
                       spec_dir=os.path.join(tmp, 'spec'))
    res = r[0] if isinstance(r, list) else r
    segs = [{"start": float(s.start), "end": float(s.end), "label": str(s.label)}
            for s in res.segments]
    sys.stdout.write(json.dumps({"bpm": getattr(res, "bpm", None), "segments": segs}))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`.trim()

/** Probe whether allin1 is importable in the configured Python. */
export function phraseAvailable(pythonPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false
    const proc = spawn(pythonPath, ['-c', 'import allin1, sys; sys.stdout.write("ok")'])
    proc.stdout.on('data', () => (ok = true))
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(ok && code === 0))
  })
}

const _liveProcs = new Set<ChildProcess>()

/** Kill any in-flight phrase jobs (call from app 'before-quit'). */
export function killAllPhraseJobs(): void {
  for (const p of _liveProcs) {
    try { p.kill('SIGTERM') } catch { /* already gone */ }
  }
  _liveProcs.clear()
}

/** Map an all-in-one analysis result to Offcut phrase segments (exported for tests). */
export function toSegments(raw: { segments?: { start: number; end: number; label: string }[] }): PhraseSegment[] {
  const out: PhraseSegment[] = []
  for (const s of raw.segments ?? []) {
    const label = LABEL_MAP[s.label?.toLowerCase?.()] ?? null
    if (!label) continue
    const startMs = Math.max(0, Math.round(s.start * 1000))
    const endMs = Math.round(s.end * 1000)
    if (endMs <= startMs) continue
    out.push({ label, startMs, endMs, confidence: 0.8 })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Detect phrase segments from audio. `onProgress(percent, label)` streams the
 * model's tqdm progress. Rejects with a helpful message if allin1 is missing.
 */
export function detectPhrases(
  filePath: string,
  pythonPath: string,
  onProgress?: (percent: number, label: string) => void
): Promise<PhraseSegment[]> {
  return new Promise((resolve, reject) => {
    onProgress?.(0, 'starting phrase analysis…')
    const proc = spawn(pythonPath, ['-c', SCRIPT, filePath])
    _liveProcs.add(proc)
    proc.on('close', () => _liveProcs.delete(proc))

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    proc.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      stderr += s
      const m = s.match(/(\d+)%/g)
      if (m?.length) {
        const pct = parseInt(m[m.length - 1], 10)
        if (!Number.isNaN(pct)) onProgress?.(pct, 'analysing structure…')
      }
    })

    proc.on('error', (err) => reject(new Error(`Couldn't launch Python (${pythonPath}): ${err.message}`)))
    proc.on('close', (code) => {
      if (code !== 0) {
        if (/No module named allin1|ModuleNotFoundError/i.test(stderr)) {
          reject(new Error('all-in-one is not installed. Run: pip install allin1'))
        } else {
          reject(new Error(`Phrase analysis failed (exit ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`))
        }
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { segments?: { start: number; end: number; label: string }[] }
        onProgress?.(100, 'done')
        resolve(toSegments(parsed))
      } catch {
        reject(new Error('Phrase analysis returned no parseable result.'))
      }
    })
  })
}
