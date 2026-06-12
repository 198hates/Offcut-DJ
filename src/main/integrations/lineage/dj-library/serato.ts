// Read a Serato crate (_Serato_/Subcrates/<name>.crate). The format is a flat
// sequence of tagged fields: 4-byte ASCII tag, 4-byte big-endian length, then
// the payload. Track entries are 'otrk' blocks, each containing a 'ptrk' field
// whose payload is the file path as UTF-16 big-endian.
//
// Reading is enough for dedup + taste signals. Writing crates is fiddlier
// (Serato also records crate order in _Serato_/neworder.pref), so the Rekordbox
// writer is the cleaner export target.

import { readFileSync } from 'node:fs'

// Node has no native UTF-16BE decoder, so byte-swap to LE then decode.
function utf16beToString(buf: Buffer): string {
  const swapped = Buffer.allocUnsafe(buf.length)
  for (let k = 0; k + 1 < buf.length; k += 2) {
    swapped[k] = buf[k + 1]
    swapped[k + 1] = buf[k]
  }
  return swapped.toString('utf16le')
}

export function readSeratoCrate(cratePath: string): string[] {
  const buf = readFileSync(cratePath)
  const paths: string[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const tag = buf.toString('ascii', i, i + 4)
    const len = buf.readUInt32BE(i + 4)
    const payload = buf.subarray(i + 8, i + 8 + len)
    if (tag === 'otrk') {
      // Walk the nested fields inside this track block for its 'ptrk' path.
      let j = 0
      while (j + 8 <= payload.length) {
        const subTag = payload.toString('ascii', j, j + 4)
        const subLen = payload.readUInt32BE(j + 4)
        const sub = payload.subarray(j + 8, j + 8 + subLen)
        if (subTag === 'ptrk') paths.push(utf16beToString(sub))
        j += 8 + subLen
      }
    }
    i += 8 + len
  }
  return paths // crate-relative file paths
}
