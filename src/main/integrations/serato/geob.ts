/**
 * Serato GEOB ID3 tag parser for cue points and BPM.
 *
 * Serato stores cue points, beatgrid, and other data in custom ID3 GEOB frames
 * embedded directly in audio files. This supplements the crate file import
 * (which only gives us file paths) with actual performance data.
 *
 * Relevant frames:
 *   GEOBSerato Markers2  — hot cues, loops, flip markers
 *   GEOBSerato BeatGrid  — beatgrid markers
 *   GEOBSerato Overview  — waveform overview (ignored here)
 *
 * Binary format references:
 *   https://github.com/mixxxdj/mixxx/wiki/Serato-Tags
 */

import { readFileSync, existsSync } from 'fs'
import type { CuePoint, BeatgridMarker } from '../../../shared/types'

const FRAME_SIZE = 4

interface ParsedSeratoData {
  cuePoints: CuePoint[]
  beatgrid: BeatgridMarker[]
  bpm: number | null
}

export function parseSeratoTagsFromFile(filePath: string): ParsedSeratoData {
  const empty: ParsedSeratoData = { cuePoints: [], beatgrid: [], bpm: null }
  if (!existsSync(filePath)) return empty

  try {
    const buf = readFileSync(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase()

    if (ext === 'mp3' || ext === 'aiff' || ext === 'aif') {
      return parseID3Serato(buf)
    }
    // FLAC/OGG handling would go here
    return empty
  } catch {
    return empty
  }
}

function parseID3Serato(buf: Buffer): ParsedSeratoData {
  const result: ParsedSeratoData = { cuePoints: [], beatgrid: [], bpm: null }

  // Find ID3v2 header
  if (buf.slice(0, 3).toString('ascii') !== 'ID3') return result

  const id3Size = decodeID3Size(buf.slice(6, 10))
  const frames = parseID3Frames(buf.slice(10, 10 + id3Size))

  const markers2 = frames.get('Serato Markers2')
  if (markers2) result.cuePoints = parseMarkers2(markers2)

  const beatgrid = frames.get('Serato BeatGrid')
  if (beatgrid) {
    const { markers, bpm } = parseBeatgrid(beatgrid)
    result.beatgrid = markers
    result.bpm = bpm
  }

  return result
}

function decodeID3Size(buf: Buffer): number {
  return ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
}

function parseID3Frames(buf: Buffer): Map<string, Buffer> {
  const frames = new Map<string, Buffer>()
  let offset = 0

  while (offset + 10 < buf.length) {
    const id = buf.slice(offset, offset + FRAME_SIZE).toString('ascii').replace(/\0/g, '')
    if (!id || id[0] < 'A' || id[0] > 'Z') break

    const size = buf.readUInt32BE(offset + FRAME_SIZE)
    const dataStart = offset + 10
    const dataEnd = dataStart + size

    if (dataEnd > buf.length) break

    if (id === 'GEOB') {
      // GEOB: encoding(1) + mime(variable) + \0 + filename(variable) + \0 + description(variable) + \0 + data
      const data = buf.slice(dataStart, dataEnd)
      const mimeEnd = data.indexOf(0, 1)
      if (mimeEnd < 0) { offset = dataEnd; continue }
      const fileEnd = data.indexOf(0, mimeEnd + 1)
      if (fileEnd < 0) { offset = dataEnd; continue }
      const descEnd = data.indexOf(0, fileEnd + 1)
      if (descEnd < 0) { offset = dataEnd; continue }
      const desc = data.slice(fileEnd + 1, descEnd).toString('latin1')
      const content = data.slice(descEnd + 1)
      if (desc.startsWith('Serato ')) {
        frames.set(desc, content)
      }
    }

    offset = dataEnd
  }

  return frames
}

function parseMarkers2(data: Buffer): CuePoint[] {
  const cues: CuePoint[] = []
  try {
    // Serato Markers2 is base64-encoded after a header byte
    const base64 = data.slice(1).toString('latin1')
    const decoded = Buffer.from(base64, 'base64')
    let offset = 0

    while (offset < decoded.length) {
      const typeEnd = decoded.indexOf(0, offset)
      if (typeEnd < 0) break
      const type = decoded.slice(offset, typeEnd).toString('ascii')
      const len = decoded.readUInt32BE(typeEnd + 1)
      const entryData = decoded.slice(typeEnd + 5, typeEnd + 5 + len)
      offset = typeEnd + 5 + len

      if (type === 'CUE') {
        const index = entryData.readUInt8(1)
        const posMs = entryData.readUInt32BE(2)
        const r = entryData.readUInt8(7)
        const g = entryData.readUInt8(8)
        const b = entryData.readUInt8(9)
        const label = entryData.slice(11).toString('utf8').replace(/\0/g, '')
        cues.push({
          index,
          type: 'hotcue',
          positionMs: posMs,
          color: `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`,
          label
        })
      } else if (type === 'LOOP') {
        const index = entryData.readUInt8(1)
        const posMs = entryData.readUInt32BE(2)
        const label = entryData.slice(17).toString('utf8').replace(/\0/g, '')
        cues.push({
          index,
          type: 'loop',
          positionMs: posMs,
          color: '#ff8c00',
          label
        })
      }
    }
  } catch { /* ignore parse errors */ }
  return cues
}

function parseBeatgrid(data: Buffer): { markers: BeatgridMarker[]; bpm: number | null } {
  const markers: BeatgridMarker[] = []
  let bpm: number | null = null
  try {
    // Serato BeatGrid: 4 byte header, then entries
    let offset = 4
    while (offset + 8 <= data.length) {
      const positionMs = data.readFloatBE(offset) * 1000
      const beatsPerBar = data.readUInt8(offset + 4)
      const beatsBpm = data.readFloatBE(offset + 5)
      if (bpm === null) bpm = beatsBpm
      markers.push({ positionMs, bpm: beatsBpm })
      offset += 9
      if (beatsPerBar === 0) break
    }
  } catch { /* ignore */ }
  return { markers, bpm }
}
