// Read beat grid + cue points out of a Rekordbox ANLZ .DAT file, for importing
// USB backups with their original analysis intact.
//
// Parsed by hand (big-endian) rather than via Kaitai: for a full backup we read
// one of these per track (thousands), and the per-beat object overhead of the
// generated parser is far too slow / blocks the main process.

import { readFileSync } from 'fs'
import type { BeatgridMarker, CuePoint } from '../../../shared/types'

export interface AnlzAnalysis {
  beatgrid: BeatgridMarker[]
  cuePoints: CuePoint[]
}

const DEFAULT_CUE_COLOR = '#ff8c00'

export function readAnlzAnalysis(datPath: string): AnlzAnalysis {
  const beatgrid: BeatgridMarker[] = []
  const cuePoints: CuePoint[] = []

  let buf: Buffer
  try {
    buf = readFileSync(datPath)
  } catch {
    return { beatgrid, cuePoints }
  }

  // The whole parse is best-effort: a malformed/unexpected ANLZ must never fail
  // the surrounding track import — we just return whatever we managed to read.
  try {
    if (buf.length < 28 || buf.toString('ascii', 0, 4) !== 'PMAI') return { beatgrid, cuePoints }

    let pos = buf.readUInt32BE(4) // len_header → first section
    let cueIndex = 0
    while (pos + 12 <= buf.length) {
      const fourcc = buf.toString('ascii', pos, pos + 4)
      const secLenHeader = buf.readUInt32BE(pos + 4)
      const secLenTag = buf.readUInt32BE(pos + 8)
      if (secLenTag < 12 || pos + secLenTag > buf.length) break
      const tagEnd = pos + secLenTag

      if (fourcc === 'PQTZ' && pos + 24 <= tagEnd) {
        const numBeats = buf.readUInt32BE(pos + 20)
        let off = pos + 24
        for (let i = 0; i < numBeats && off + 8 <= tagEnd; i++, off += 8) {
          beatgrid.push({
            positionMs: buf.readUInt32BE(off + 4) >>> 0,
            bpm: buf.readUInt16BE(off + 2) / 100,
            isDownbeat: buf.readUInt16BE(off) === 1
          })
        }
      } else if (fourcc === 'PCOB' && pos + 20 <= tagEnd) {
        const listIsHot = buf.readUInt32BE(pos + 12) === 1 // 0 memory, 1 hot
        const numCues = buf.readUInt16BE(pos + 18)
        let off = pos + secLenHeader
        for (let i = 0; i < numCues; i++) {
          if (off + 0x24 > tagEnd) break
          if (buf.toString('ascii', off, off + 4) !== 'PCPT') break
          const entLen = buf.readUInt32BE(off + 8)
          const cueType = buf.readUInt8(off + 0x1c)
          cuePoints.push({
            index: cueIndex++,
            type: cueType === 2 ? 'loop' : listIsHot ? 'hotcue' : 'memory',
            positionMs: buf.readUInt32BE(off + 0x20) >>> 0,
            color: DEFAULT_CUE_COLOR,
            label: ''
          })
          if (entLen < 0x24 || off + entLen <= off) break
          off += entLen
        }
      }
      pos += secLenTag
    }
  } catch {
    /* return whatever we read */
  }
  return { beatgrid, cuePoints }
}
