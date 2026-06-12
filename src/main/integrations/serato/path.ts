// Shared Serato path/encoding helpers — keep the reader and writer in lock-step.
//
// Serato `.crate` records store the track path (`ptrk`) as UTF-16 BIG-ENDIAN
// text, relative to the volume root (no leading slash on macOS/Linux; the
// drive-relative path on Windows). See:
//   https://github.com/mixxxdj/mixxx/wiki/Serato-Database-Format

/** Encode a string as UTF-16BE (Serato's on-disk encoding for path/text tags). */
export function encodeSeratoUtf16BE(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2)
  for (let i = 0; i < str.length; i++) buf.writeUInt16BE(str.charCodeAt(i), i * 2)
  return buf
}

/** Decode UTF-16BE bytes. Node has no 'utf16be', so swap each pair then read LE. */
export function decodeSeratoUtf16BE(buf: Buffer): string {
  const swapped = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1]
    swapped[i + 1] = buf[i]
  }
  if (buf.length % 2 === 1) swapped[buf.length - 1] = buf[buf.length - 1]
  return swapped.toString('utf16le')
}

/** Absolute local path → Serato's volume-relative form. */
export function toSeratoPath(absPath: string): string {
  if (process.platform === 'win32') {
    // C:\Users\dj\x.mp3 → Users/dj/x.mp3
    return absPath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '')
  }
  // /Users/dj/x.mp3 → Users/dj/x.mp3
  return absPath.replace(/^\/+/, '')
}

/**
 * Serato's volume-relative path → an absolute local path.
 *
 * On macOS/Linux this re-anchors to the volume root (correct for the boot
 * volume; tracks on a *named external* volume would also need that volume's
 * mount point, which the crate doesn't record). On Windows the drive letter
 * isn't stored, so the path is returned forward-slashed and drive-relative.
 */
export function fromSeratoPath(relPath: string): string {
  if (process.platform === 'win32') return relPath.replace(/\\/g, '/')
  return relPath.startsWith('/') ? relPath : '/' + relPath
}
