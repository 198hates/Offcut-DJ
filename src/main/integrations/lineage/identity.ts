// A universal recording identity so the same track is recognised across every
// service, and so untagged files can be identified from sound alone.
//
//   tags  : artist + title  -> MusicBrainz recording -> ISRC(s)
//   audio : a file path      -> Chromaprint fingerprint -> AcoustID -> MBID -> ISRC(s)
//
// The ISRC is the join key: with it you can hit a service directly (e.g.
// Deezer's isrc: lookup) instead of fuzzy-matching artist + title.
//
// Requirements:
//   - The `fpcalc` binary (from Chromaprint), bundled with the app or on PATH.
//   - A free AcoustID application API key.
//   - A descriptive User-Agent (MusicBrainz requires one).

import { spawn } from 'node:child_process'
import { RateLimiter } from './rate-limiter'
import { httpJson } from './http'
import { looksLikeMatch } from './match'
import type { DeezerTrack, IdentityResult } from './types'

const mbLimiter = new RateLimiter(1100) // MusicBrainz: <= 1/sec
const acoustLimiter = new RateLimiter(350) // AcoustID: be gentle
const MB = 'https://musicbrainz.org/ws/2'

// AcoustID returns an acoustic-confidence score (0–1) per result. Below this we
// treat the fingerprint as inconclusive rather than accept a wrong recording —
// a bad identity silently poisons every downstream ISRC/preview lookup.
const MIN_ACOUSTID_SCORE = 0.5

/** Escape the characters that would break a quoted Lucene phrase. */
function lucenePhrase(s: string): string {
  return s.replace(/(["\\])/g, '\\$1')
}

interface Fingerprint {
  duration: number
  fingerprint: string
}

export class Identity {
  private acoustidKey?: string
  private userAgent: string
  private fpcalcPath: string

  constructor({
    acoustidKey,
    userAgent,
    fpcalcPath = 'fpcalc'
  }: {
    acoustidKey?: string
    userAgent: string
    fpcalcPath?: string
  }) {
    this.acoustidKey = acoustidKey
    this.userAgent = userAgent
    this.fpcalcPath = fpcalcPath
  }

  // --- audio path -------------------------------------------------------

  // Chromaprint fpcalc -> { duration, fingerprint }.
  fingerprintFile(filePath: string): Promise<Fingerprint> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.fpcalcPath, ['-json', filePath])
      let out = ''
      let err = ''
      proc.stdout.on('data', (d) => (out += d))
      proc.stderr.on('data', (d) => (err += d))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`fpcalc failed: ${err || code}`))
        try {
          const { duration, fingerprint } = JSON.parse(out) as Fingerprint
          resolve({ duration: Math.round(duration), fingerprint })
        } catch (e) {
          reject(e as Error)
        }
      })
    })
  }

  // Ask AcoustID which MusicBrainz recording a fingerprint belongs to.
  async lookupByFingerprint({ duration, fingerprint }: Fingerprint): Promise<string | null> {
    if (!this.acoustidKey) throw new Error('AcoustID key required for fingerprint lookup')
    const body = new URLSearchParams({
      client: this.acoustidKey,
      duration: String(duration),
      fingerprint,
      meta: 'recordingids'
    })
    const res = await acoustLimiter.schedule(() =>
      fetch('https://api.acoustid.org/v2/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      })
    )
    if (!res.ok) throw new Error(`AcoustID -> ${res.status}`)
    const data = (await res.json()) as {
      results?: { score?: number; recordings?: { id: string }[] }[]
    }
    const best = (data.results || []).sort((a, b) => (b.score || 0) - (a.score || 0))[0]
    // Reject a low-confidence acoustic match instead of guessing.
    if (!best || (best.score || 0) < MIN_ACOUSTID_SCORE) return null
    return best.recordings?.[0]?.id || null // a MusicBrainz recording MBID
  }

  // --- tag path ---------------------------------------------------------

  async recordingByArtistTitle({
    artist,
    title
  }: {
    artist: string
    title: string
  }): Promise<string | null> {
    // Quote the phrases (and escape any embedded quotes/backslashes — a title
    // like `Back"slash` would otherwise break the query syntax).
    const q = encodeURIComponent(
      `artist:"${lucenePhrase(artist)}" AND recording:"${lucenePhrase(title)}"`
    )
    const data = await this.mb<{
      recordings?: {
        id: string
        title?: string
        'artist-credit'?: { name?: string; artist?: { name?: string } }[]
      }[]
    }>(`/recording?query=${q}&fmt=json&limit=5`)
    // The Lucene relevance score is relative to the query, so the top hit is
    // always "score 100" even for a poor match. Verify the candidate's actual
    // artist/title against what we searched and take the first that lines up.
    for (const rec of data.recordings || []) {
      const credit = (rec['artist-credit'] || [])
        .map((a) => a.name || a.artist?.name || '')
        .join(' ')
        .trim()
      if (looksLikeMatch({ artist, title }, credit, rec.title)) return rec.id
    }
    return null
  }

  // --- shared -----------------------------------------------------------

  async isrcsForRecording(mbid: string): Promise<string[]> {
    const data = await this.mb<{ isrcs?: string[] }>(`/recording/${mbid}?inc=isrcs&fmt=json`)
    return data.isrcs || []
  }

  // input: { filePath } OR { artist, title }
  // -> { mbid, isrcs, source } | null   (ISRC may be empty; not every recording has one)
  async identify(input: {
    filePath?: string
    artist?: string
    title?: string
  }): Promise<IdentityResult | null> {
    let mbid: string | null = null
    let source: IdentityResult['source'] | null = null
    if (input.filePath) {
      mbid = await this.lookupByFingerprint(await this.fingerprintFile(input.filePath))
      source = 'fingerprint'
    }
    if (!mbid && input.artist && input.title) {
      mbid = await this.recordingByArtistTitle({ artist: input.artist, title: input.title })
      source = 'metadata'
    }
    if (!mbid || !source) return null
    return { mbid, isrcs: await this.isrcsForRecording(mbid), source }
  }

  // Sample / cover / remix lineage from MusicBrainz — open and structured,
  // though sample coverage is patchy. WhoSampled is far denser if you obtain
  // their (gated) API; this method's output shape is the swap-in point.
  async relatedRecordings(
    mbid: string
  ): Promise<{ type: string; artist: string; title: string }[]> {
    const data = await this.mb<{
      relations?: {
        type?: string
        recording?: {
          title?: string
          'artist-credit'?: { name?: string; artist?: { name?: string } }[]
        }
      }[]
    }>(`/recording/${mbid}?inc=recording-rels+artist-credits&fmt=json`)
    const out: { type: string; artist: string; title: string }[] = []
    for (const r of data.relations || []) {
      const rec = r.recording
      if (!rec || !rec.title) continue
      const artist = (rec['artist-credit'] || [])
        .map((a) => a.name || a.artist?.name || '')
        .join('')
        .trim()
      out.push({ type: r.type || 'related', artist, title: rec.title })
    }
    return out
  }

  private mb<T>(path: string): Promise<T> {
    return mbLimiter.schedule(() =>
      httpJson<T>(MB + path, { headers: { 'User-Agent': this.userAgent }, label: `MusicBrainz ${path}` })
    )
  }
}

// The kind of clean cross-service join an ISRC unlocks: fetch the exact track.
export async function deezerByIsrc(isrc: string): Promise<DeezerTrack | null> {
  const res = await fetch(`https://api.deezer.com/track/isrc:${isrc}`)
  if (!res.ok) return null
  const t = (await res.json()) as Partial<DeezerTrack> & { id?: number }
  return t?.id ? { id: t.id, title: t.title || '', preview: t.preview || '', link: t.link || '' } : null
}
