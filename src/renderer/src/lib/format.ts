/**
 * Shared formatting helpers — consolidates the duration / BPM / file-size /
 * sample-rate / hash-hue snippets that were duplicated across ~12 files.
 */

/** Seconds → "m:ss" (e.g. 3:07). Returns `dash` for null/invalid. */
export function formatDuration(
  seconds: number | null | undefined,
  { round = true, dash = '—' }: { round?: boolean; dash?: string } = {}
): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return dash
  const total = round ? Math.round(seconds) : Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Seconds → "Xh YYm" (or "Ym" under an hour) for set-length summaries. */
export function formatHoursMinutes(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`
}

/** Seconds → "m:ss.t" with tenths (deck/transport readouts). */
export function formatTime(seconds: number | null | undefined, dash = '0:00.0'): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return dash
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const t = Math.floor((seconds * 10) % 10)
  return `${m}:${s.toString().padStart(2, '0')}.${t}`
}

/** BPM → fixed-decimal string (default 1 dp). Returns `dash` for null/invalid. */
export function formatBpm(bpm: number | null | undefined, decimals = 1, dash = '—'): string {
  if (bpm == null || !isFinite(bpm)) return dash
  return bpm.toFixed(decimals)
}

/** Bytes → "1.2MB" / "640KB". */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.round(bytes / 1024)}KB`
}

/** Hz → "44.1k". */
export function formatSampleRate(hz: number | null | undefined): string {
  if (!hz) return '—'
  return `${(hz / 1000).toFixed(1)}k`
}

/** Deterministic 0–359 hue from a string (stable colour-from-name). */
export function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}
