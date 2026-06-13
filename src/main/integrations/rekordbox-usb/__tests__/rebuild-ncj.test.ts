import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseExportPdb } from '../reader'
import { buildExportPdb, type PdbTrack, type PdbPlaylist } from '../pdb-builder'

// One-off: rebuild a stick's export.pdb using the new from-scratch CDJ-format
// builder, reusing the existing track/playlist data (so on-stick audio/ANLZ
// still resolve). Gated behind REBUILD_SRC / REBUILD_DST env vars.
describe('rebuild an export.pdb with the new builder', () => {
  it('regenerates from existing data', () => {
    const src = process.env.REBUILD_SRC
    const dst = process.env.REBUILD_DST
    if (!src || !existsSync(src)) { expect(true).toBe(true); return }

    const { tracks, playlists } = parseExportPdb(readFileSync(src) as Buffer)
    const T = join(__dirname, '../templates')
    const history = {
      p36: readFileSync(join(T, 'history-p36.bin')) as Buffer,
      p38: readFileSync(join(T, 'history-p38.bin')) as Buffer,
      p40: readFileSync(join(T, 'history-p40.bin')) as Buffer
    }
    const pdbTracks: PdbTrack[] = tracks.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album || '', genre: t.genre || '',
      label: '', remixer: '', key: t.key || '', sampleRate: 44100,
      fileSize: 8_000_000, bitrate: 0, trackNumber: 0,
      tempo: t.bpm != null ? Math.round(t.bpm * 100) : 0, discNumber: 0,
      year: t.year ?? 0, durationSecs: t.durationSeconds ?? 0,
      fileName: basename(t.filePath), fileExt: (t.filePath.split('.').pop() || 'mp3'),
      usbPath: t.filePath, analyzePath: t.analyzePath || '', comment: ''
    }))
    const flat = (ns: typeof playlists, out: typeof playlists = []): typeof playlists => {
      for (const n of ns) { out.push(n); if (n.children) flat(n.children, out) }
      return out
    }
    const pdbPlaylists: PdbPlaylist[] = flat(playlists)
      .filter((p) => !p.isFolder)
      .map((p) => ({ id: p.id, name: p.name, trackIds: p.trackIds ?? [] }))

    const out = buildExportPdb(pdbTracks, pdbPlaylists, history, '2026-06-13')
    expect(out.length % 4096).toBe(0)
    if (dst) { writeFileSync(dst, out); console.log(`wrote ${out.length / 4096} pages to ${dst} (${pdbTracks.length} tracks, ${pdbPlaylists.length} playlists)`) }
  })
})
