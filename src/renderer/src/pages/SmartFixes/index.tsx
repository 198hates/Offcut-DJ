import { useState, useCallback } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { inferGenre } from '../../lib/genreInference'
import type { Track } from '@shared/types'

// ── Fix algorithms ────────────────────────────────────────────────────────────

const MINOR_WORDS = new Set([
  'a','an','the','and','but','or','nor','for','so','yet',
  'at','by','in','of','on','to','up','via','as','is','vs','feat','ft'
])

function toTitleCase(str: string): string {
  return str
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word, i) => {
      const low = word.toLowerCase()
      // Always cap first word, never cap minor words in subsequent positions
      if (i === 0 || !MINOR_WORDS.has(low)) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      }
      return low
    })
    .join(' ')
}

function needsCasing(str: string): boolean {
  if (!str || str.length < 3) return false
  const hasLetter = /[a-zA-Z]/.test(str)
  if (!hasLetter) return false
  const isAllCaps  = str === str.toUpperCase() && /[A-Z]{2}/.test(str)
  const isAllLower = str === str.toLowerCase() && /[a-z]{3}/.test(str) && !/^\d/.test(str)
  return isAllCaps || isAllLower
}

function fixEncoded(str: string): string {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/(?:&apos;|&#x27;|&#39;)/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

const PROMO_RE = [
  /\s*[\[(]?\s*free\s+(?:download|dl)\s*[\])]?/gi,
  /\s*[\[(]?\s*out\s+now\s*[\])]?/gi,
  /\s*[\[(]?\s*buy\s+now\s*[\])]?/gi,
  /\s*[\[(]?\s*available\s+(?:now|on\s+\w+)\s*[\])]?/gi,
  /\s*[\[(]?\s*exclusive\s*[\])]?/gi,
  /\s*[\[(]?\s*promo(?:tional)?\s*[\])]?/gi,
  /\s*[\[(]?\s*pre-?order\s*[\])]?/gi,
  /\s*[\[(]?\s*supported\s+by[^\])]*/gi,
  /\s*[\[(]?\s*played\s+by[^\])]*/gi,
  /\s*[\[(]?\s*(?:released|releasing)\s+(?:on\s+)?\w+\s*[\])]?/gi,
]

function removePromo(str: string): string {
  let s = str
  for (const re of PROMO_RE) s = s.replace(re, ' ')
  return s.replace(/\s{2,}/g, ' ').trim()
}

function removeNumberPrefix(str: string): string {
  return str.replace(/^\d{1,3}[\s._-]+/, '').trim()
}

// Version qualifier patterns — things like "(Radio Edit)", "(Extended Mix)", "(Original Mix)"
// that the user may want stripped for cleaner titles. Only common, unambiguous patterns.
const VERSION_RE = /\s*(?:\(|\[)\s*(?:radio\s+edit|radio\s+version|single\s+edit|single\s+version|extended(?:\s+version|\s+mix)?|extended\s+instrumental|album\s+version|original\s+mix|club\s+mix|instrumental(?:\s+version)?|a\s+cappella|acappella|dj\s+tool|clean(?:\s+version)?|explicit(?:\s+version)?|re-?master(?:ed)?(?:\s+version)?)\s*(?:\)|\])/gi

function stripVersionQualifier(str: string): string {
  return str.replace(VERSION_RE, '').replace(/\s{2,}/g, ' ').trim()
}

const URL_RE = /(?:https?:\/\/|www\.)\S+|\S+@\S+\.\w{2,}/gi

function removeUrls(str: string): string {
  return str.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim()
}

function replaceUnderscores(str: string): string {
  return str.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function extractArtistFromTitle(title: string, currentArtist: string): { title: string; artist: string } | null {
  if (currentArtist.trim()) return null   // don't overwrite existing artist
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (!m || !m[1] || !m[2]) return null
  return { artist: m[1].trim(), title: m[2].trim() }
}

const REMIXER_RE = [
  /\s*(?:\(|\[)([^)\]]+?)\s+(?:remix|edit|rework|bootleg|flip|mix)(?:\)|\])/i,
  /\s*(?:\(|\[)(?:remixed|mixed)\s+by\s+([^)\]]+)(?:\)|\])/i,
]

/** Extract a usable title from a bare file path, stripping extension + leading numbers */
function titleFromPath(filePath: string): string | null {
  const base = filePath.split('/').pop()?.split('\\').pop() ?? ''
  const noExt = base.replace(/\.[a-zA-Z0-9]{2,4}$/, '').trim()
  if (!noExt) return null
  // Remove leading track numbers
  const cleaned = noExt.replace(/^\d{1,3}[\s._-]+/, '').trim()
  // If "Artist - Title" format, take the right half
  const split = cleaned.match(/^.+?\s+[-–—]\s+(.+)$/)
  return (split ? split[1] : cleaned).trim() || null
}

// Key notation normalization — converts any known format to Camelot (e.g. "Cmaj" → "8B")
const KEY_TO_CAMELOT: Record<string, string> = {
  'Cmaj': '8B',  'C#maj': '3B', 'Dbmaj': '3B', 'Dmaj': '10B', 'D#maj': '5B',
  'Ebmaj': '5B', 'Emaj': '12B','Fmaj': '7B',   'F#maj': '2B', 'Gbmaj': '2B',
  'Gmaj': '9B',  'G#maj': '4B', 'Abmaj': '4B', 'Amaj': '11B', 'A#maj': '6B',
  'Bbmaj': '6B', 'Bmaj': '1B',
  'Cmin': '5A',  'C#min': '12A','Dbmin': '12A','Dmin': '7A',  'D#min': '2A',
  'Ebmin': '2A', 'Emin': '9A', 'Fmin': '4A',   'F#min': '11A','Gbmin': '11A',
  'Gmin': '6A',  'G#min': '1A', 'Abmin': '1A', 'Amin': '8A',  'A#min': '3A',
  'Bbmin': '3A', 'Bmin': '10A',
  // "C Major" / "C Minor" style
  'C Major': '8B',  'C# Major': '3B', 'Db Major': '3B', 'D Major': '10B',
  'D# Major': '5B', 'Eb Major': '5B', 'E Major': '12B', 'F Major': '7B',
  'F# Major': '2B', 'Gb Major': '2B', 'G Major': '9B',  'G# Major': '4B',
  'Ab Major': '4B', 'A Major': '11B', 'A# Major': '6B', 'Bb Major': '6B',
  'B Major': '1B',
  'C Minor': '5A',  'C# Minor': '12A','Db Minor': '12A','D Minor': '7A',
  'D# Minor': '2A', 'Eb Minor': '2A', 'E Minor': '9A',  'F Minor': '4A',
  'F# Minor': '11A','Gb Minor': '11A','G Minor': '6A',  'G# Minor': '1A',
  'Ab Minor': '1A', 'A Minor': '8A',  'A# Minor': '3A', 'Bb Minor': '3A',
  'B Minor': '10A',
}
const CAMELOT_RE = /^\d{1,2}[AB]$/i

function normalizeKeyToCamelot(key: string | null | undefined): string | null {
  if (!key) return null
  const trimmed = key.trim()
  if (CAMELOT_RE.test(trimmed)) return null   // already Camelot — no change needed
  return KEY_TO_CAMELOT[trimmed] ?? null
}

function extractRemixer(title: string): { title: string; remixerTag: string } | null {
  for (const re of REMIXER_RE) {
    const m = title.match(re)
    if (m) {
      return {
        title: title.replace(m[0], '').replace(/\s{2,}/g, ' ').trim(),
        remixerTag: `remixer:${m[1].trim()}`
      }
    }
  }
  return null
}

// ── Fix definitions ───────────────────────────────────────────────────────────

interface FixResult {
  trackId: string
  display: string    // track title for display
  field: keyof Track
  before: string
  after: string
  extra?: Partial<Track>   // additional fields to update alongside `field`
}

interface Fix {
  id: string
  label: string
  description: string
  icon: string
  scan: (tracks: Track[]) => FixResult[]
}

const FIXES: Fix[] = [
  {
    id: 'casing',
    label: 'fix casing',
    description: 'title and artist fields that are ALL CAPS or all lowercase → Title Case',
    icon: 'Aa',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        for (const field of ['title', 'artist'] as const) {
          const val = t[field] as string
          if (needsCasing(val)) {
            results.push({ trackId: t.id, display: t.title || t.filePath, field, before: val, after: toTitleCase(val) })
          }
        }
      }
      return results
    }
  },
  {
    id: 'encoded',
    label: 'fix encoded characters',
    description: 'replace HTML entities like &amp; &quot; &#39; with their real characters',
    icon: '&',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        for (const field of ['title', 'artist', 'album', 'genre', 'comment'] as const) {
          const val = t[field] as string
          if (!val) continue
          const fixed = fixEncoded(val)
          if (fixed !== val) results.push({ trackId: t.id, display: t.title || t.filePath, field, before: val, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'promo',
    label: 'remove promotional text',
    description: 'strip "Free Download", "Out Now", "Exclusive", "Promo" and similar from titles',
    icon: '✕',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        for (const field of ['title', 'comment'] as const) {
          const val = t[field] as string
          if (!val) continue
          const fixed = removePromo(val)
          if (fixed !== val) results.push({ trackId: t.id, display: t.title || t.filePath, field, before: val, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'numprefix',
    label: 'remove number prefix',
    description: 'strip leading track numbers from titles: "01 - Title" → "Title"',
    icon: '01',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        const fixed = removeNumberPrefix(t.title)
        if (fixed !== t.title && fixed.length > 0) {
          results.push({ trackId: t.id, display: t.title, field: 'title', before: t.title, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'urls',
    label: 'remove URLs',
    description: 'remove http:// links and email addresses from any field',
    icon: '⌁',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        for (const field of ['title', 'artist', 'album', 'comment'] as const) {
          const val = t[field] as string
          if (!val || !URL_RE.test(val)) { URL_RE.lastIndex = 0; continue }
          URL_RE.lastIndex = 0
          const fixed = removeUrls(val)
          if (fixed !== val) results.push({ trackId: t.id, display: t.title || t.filePath, field, before: val, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'underscores',
    label: 'replace underscores with spaces',
    description: 'convert Track_Title_Like_This → Track Title Like This in all text fields',
    icon: '_→',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        for (const field of ['title', 'artist', 'album'] as const) {
          const val = t[field] as string
          if (!val || !val.includes('_')) continue
          const fixed = replaceUnderscores(val)
          if (fixed !== val) results.push({ trackId: t.id, display: t.title || t.filePath, field, before: val, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'extract-artist',
    label: 'extract artist from title',
    description: 'when artist is empty and title contains "Artist - Title", split into separate fields',
    icon: '⑂',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        const extracted = extractArtistFromTitle(t.title, t.artist)
        if (extracted) {
          results.push({
            trackId: t.id,
            display: t.title,
            field: 'title',
            before: t.title,
            after: extracted.title,
            extra: { artist: extracted.artist }
          })
        }
      }
      return results
    }
  },
  {
    id: 'extract-remixer',
    label: 'extract remixer to tag',
    description: 'detect "(X Remix)" in titles and add a remixer:X tag — title is cleaned',
    icon: '↻',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        const extracted = extractRemixer(t.title)
        if (extracted && !t.tags.includes(extracted.remixerTag)) {
          results.push({
            trackId: t.id,
            display: t.title,
            field: 'title',
            before: t.title,
            after: extracted.title,
            extra: { tags: [...t.tags, extracted.remixerTag] }
          })
        }
      }
      return results
    }
  },
  {
    id: 'genre-normalize',
    label: 'normalize genre spelling',
    description: 'groups genres by value, picks the most-used casing/spelling, updates all variants to match — e.g. "techno", "Techno", "TECHNO" → whichever appears most',
    icon: 'G↓',
    scan: (tracks) => {
      const groups = new Map<string, Map<string, number>>()
      for (const t of tracks) {
        if (!t.genre) continue
        const key = t.genre.toLowerCase().trim()
        if (!groups.has(key)) groups.set(key, new Map())
        const vm = groups.get(key)!
        vm.set(t.genre, (vm.get(t.genre) ?? 0) + 1)
      }
      const canonical = new Map<string, string>()
      for (const [key, variants] of groups) {
        if (variants.size <= 1) continue
        const best = [...variants.entries()].sort((a, b) => b[1] - a[1])[0][0]
        canonical.set(key, best)
      }
      const results: FixResult[] = []
      for (const t of tracks) {
        if (!t.genre) continue
        const canon = canonical.get(t.genre.toLowerCase().trim())
        if (canon && t.genre !== canon)
          results.push({ trackId: t.id, display: t.title || t.filePath, field: 'genre', before: t.genre, after: canon })
      }
      return results
    }
  },
  {
    id: 'artist-normalize',
    label: 'normalize artist spelling',
    description: 'groups artists by value, picks the most-used casing/spelling, updates all variants to match — e.g. "deadmau5" vs "DeadMau5" → whichever appears most',
    icon: 'A↓',
    scan: (tracks) => {
      const groups = new Map<string, Map<string, number>>()
      for (const t of tracks) {
        if (!t.artist) continue
        const key = t.artist.toLowerCase().trim()
        if (!groups.has(key)) groups.set(key, new Map())
        const vm = groups.get(key)!
        vm.set(t.artist, (vm.get(t.artist) ?? 0) + 1)
      }
      const canonical = new Map<string, string>()
      for (const [key, variants] of groups) {
        if (variants.size <= 1) continue
        const best = [...variants.entries()].sort((a, b) => b[1] - a[1])[0][0]
        canonical.set(key, best)
      }
      const results: FixResult[] = []
      for (const t of tracks) {
        if (!t.artist) continue
        const canon = canonical.get(t.artist.toLowerCase().trim())
        if (canon && t.artist !== canon)
          results.push({ trackId: t.id, display: t.title || t.filePath, field: 'artist', before: t.artist, after: canon })
      }
      return results
    }
  },
  {
    id: 'strip-version',
    label: 'strip version qualifiers',
    description: 'removes "(Radio Edit)", "(Extended Mix)", "(Original Mix)", "(Remastered)" and similar from titles — preview first, never strips remixer credits',
    icon: '(·)',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        if (!t.title) continue
        const fixed = stripVersionQualifier(t.title)
        if (fixed !== t.title && fixed.length > 0) {
          results.push({ trackId: t.id, display: t.title, field: 'title', before: t.title, after: fixed })
        }
      }
      return results
    }
  },
  {
    id: 'normalize-key',
    label: 'normalize key notation',
    description: 'converts key fields from "Cmaj", "C Major", "C Minor" formats to Camelot notation (e.g. 8B, 5A) — required for harmonic mixing features',
    icon: '♩→',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        const camelot = normalizeKeyToCamelot(t.key)
        if (camelot) results.push({ trackId: t.id, display: t.title || t.filePath, field: 'key', before: t.key!, after: camelot })
      }
      return results
    }
  },
  {
    id: 'fill-missing-title',
    label: 'fill missing title',
    description: 'tracks with an empty title field — derives a title from the filename',
    icon: '?→',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        if (t.title && t.title.trim()) continue   // has a title already
        const derived = titleFromPath(t.filePath)
        if (derived) results.push({ trackId: t.id, display: t.filePath, field: 'title', before: '—', after: derived })
      }
      return results
    }
  },
  {
    id: 'bpm-doubling',
    label: 'fix BPM doubling',
    description: 'detects tracks where the stored BPM is half or double the analysed BPM — common when different tools disagree on half-time or double-time',
    icon: '×2',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        if (!t.bpm || !t.analysedBeatgrid) continue
        const stored   = t.bpm
        const analysed = t.analysedBeatgrid.medianBpm
        if (!analysed || analysed <= 0) continue

        // Is stored BPM about half the analysed?  → double it
        if (Math.abs(stored * 2 - analysed) / analysed < 0.04) {
          const fixed = Math.round(stored * 2 * 10) / 10
          results.push({ trackId: t.id, display: t.title || t.filePath, field: 'bpm',
            before: `${stored.toFixed(1)} bpm`, after: `${fixed.toFixed(1)} bpm`,
            extra: { bpm: fixed } })
        }
        // Is stored BPM about double the analysed? → halve it
        else if (Math.abs(stored / 2 - analysed) / analysed < 0.04) {
          const fixed = Math.round(stored / 2 * 10) / 10
          results.push({ trackId: t.id, display: t.title || t.filePath, field: 'bpm',
            before: `${stored.toFixed(1)} bpm`, after: `${fixed.toFixed(1)} bpm`,
            extra: { bpm: fixed } })
        }
      }
      return results
    }
  },
  {
    id: 'suggest-genres',
    label: 'suggest genres',
    description: 'infer a genre from BPM, energy, mood and key for tracks with no genre tag — uses rule-based scoring, always previewed before applying',
    icon: '♬',
    scan: (tracks) => {
      const results: FixResult[] = []
      for (const t of tracks) {
        if (t.genre) continue          // already has a genre — skip
        if (!t.bpm)  continue          // need at least BPM to infer
        const result = inferGenre(t)
        if (!result || result.confidence < 0.55) continue
        const label = result.confidence >= 0.75
          ? result.genre
          : `${result.genre} (${Math.round(result.confidence * 100)}% — runner-up: ${result.runnerUp ?? '—'})`
        results.push({
          trackId: t.id,
          display: t.title || t.filePath,
          field: 'genre',
          before: '—',
          after: label,
          extra: { genre: result.genre },
        })
      }
      return results
    }
  },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export function SmartFixesPage(): JSX.Element {
  const { tracks, updateTrack } = useLibraryStore()
  const [openFix, setOpenFix] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, FixResult[]>>({})
  const [applying, setApplying] = useState<string | null>(null)
  const [applied, setApplied] = useState<Record<string, number>>({})

  const scan = useCallback((fix: Fix) => {
    const res = fix.scan(tracks)
    setResults((r) => ({ ...r, [fix.id]: res }))
    setOpenFix(fix.id)
  }, [tracks])

  const applyFix = useCallback(async (fix: Fix) => {
    const res = results[fix.id] ?? []
    if (!res.length) return
    setApplying(fix.id)
    let count = 0
    for (const r of res) {
      const patch: Partial<Track> & { id: string } = {
        id: r.trackId,
        [r.field]: r.after,
        ...r.extra
      }
      await updateTrack(patch)
      count++
    }
    setApplied((a) => ({ ...a, [fix.id]: count }))
    setResults((r) => ({ ...r, [fix.id]: [] }))
    setApplying(null)
  }, [results, updateTrack])

  return (
    <div className="h-full overflow-y-auto p-6 space-y-2 max-w-3xl">
      <div className="mb-6">
        <h1 className="font-mono text-base font-bold uppercase tracking-[0.12em] text-ink">
          <span className="text-accent mr-2">01</span>smart fixes
        </h1>
        <p className="font-mono text-[10px] text-muted mt-0.5">
          scan · preview · apply — each fix shows exact before/after before changing anything
        </p>
      </div>

      {FIXES.map((fix, i) => {
        const isOpen    = openFix === fix.id
        const res       = results[fix.id] ?? []
        const isApplied = applied[fix.id] != null
        const isBusy    = applying === fix.id

        return (
          <div key={fix.id} className="border border-border/30 rounded overflow-hidden">
            {/* Row header */}
            <div
              className={`flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors ${
                isOpen ? 'bg-chassis-soft' : 'bg-ink/[0.02] hover:bg-ink/[0.04]'
              }`}
              onClick={() => isOpen ? setOpenFix(null) : scan(fix)}
            >
              {/* Number */}
              <span className="font-mono text-[9px] text-muted w-4 shrink-0 tabular-nums text-right">
                {String(i + 1).padStart(2, '0')}
              </span>

              {/* Icon chip */}
              <div className="w-8 h-8 shrink-0 rounded bg-ink/5 border border-border/30 flex items-center justify-center font-mono text-[10px] font-bold text-muted">
                {fix.icon}
              </div>

              {/* Label + description */}
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[10.5px] font-bold text-ink">{fix.label}</p>
                <p className="font-mono text-[9.5px] text-muted truncate mt-0.5">{fix.description}</p>
              </div>

              {/* Status / action */}
              <div className="shrink-0 flex items-center gap-2">
                {isApplied && (
                  <span className="font-mono text-[9.5px] text-green-600 dark:text-green-400">
                    ✓ {applied[fix.id]} fixed
                  </span>
                )}
                {!isOpen ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); scan(fix) }}
                    className="px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.1em] bg-ink/5 hover:bg-ink/10 border border-border/40 rounded transition-colors text-ink-soft hover:text-ink"
                  >
                    scan
                  </button>
                ) : (
                  <span className="font-mono text-[9.5px] text-muted uppercase tracking-[0.1em]">
                    {res.length} found
                  </span>
                )}
              </div>
            </div>

            {/* Expanded results */}
            {isOpen && (
              <div className="border-t border-border/20">
                {res.length === 0 ? (
                  <div className="px-4 py-4 flex items-center gap-2">
                    <span className="text-green-600 dark:text-green-400 font-mono text-[10px]">✓</span>
                    <span className="font-mono text-[10px] text-muted">no issues found</span>
                  </div>
                ) : (
                  <>
                    {/* Apply bar */}
                    <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-border/20">
                      <span className="font-mono text-[10px] text-ink-soft">
                        <span className="text-accent font-bold">{res.length}</span> track{res.length !== 1 ? 's' : ''} affected
                      </span>
                      <button
                        onClick={() => applyFix(fix)}
                        disabled={isBusy}
                        className="px-4 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] bg-accent hover:bg-accent/90 text-paper rounded transition-colors disabled:opacity-40"
                      >
                        {isBusy ? 'applying…' : `apply to ${res.length}`}
                      </button>
                    </div>

                    {/* Before/after preview */}
                    <div className="max-h-64 overflow-y-auto divide-y divide-border/15">
                      {res.slice(0, 200).map((r, j) => (
                        <div key={j} className="px-4 py-2 grid grid-cols-[1fr_1fr] gap-4 items-baseline">
                          <div className="min-w-0">
                            <p className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted mb-0.5">
                              {r.field}{r.extra ? ` + ${Object.keys(r.extra).join(', ')}` : ''}
                            </p>
                            <p className="font-sans text-[11px] text-ink-soft truncate">{r.before}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="font-mono text-[8.5px] uppercase tracking-[0.1em] text-accent mb-0.5">after</p>
                            <p className="font-sans text-[11px] text-ink font-medium truncate">{r.after}</p>
                            {r.extra && (
                              <p className="font-mono text-[9px] text-muted truncate mt-0.5">
                                {Object.entries(r.extra).map(([k, v]) =>
                                  `${k}: ${Array.isArray(v) ? v.join(', ') : v}`
                                ).join(' · ')}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                      {res.length > 200 && (
                        <div className="px-4 py-2 font-mono text-[9.5px] text-muted">
                          …and {res.length - 200} more
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
