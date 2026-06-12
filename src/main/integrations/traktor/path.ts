// Shared Traktor NML path helpers — keep the reader and writer in lock-step.
//
// Traktor's <LOCATION> splits a path into VOLUME / DIR / FILE, where DIR uses
// "/:" *before each* path component and a trailing "/:", e.g. a file at
//   /Users/dj/Music/song.mp3   (boot volume)
// becomes  VOLUME=""  DIR="/:Users/:dj/:Music/:"  FILE="song.mp3"
// and one on an external volume
//   /Volumes/USB/sets/song.mp3
// becomes  VOLUME="USB"  DIR="/:sets/:"  FILE="song.mp3".
//
// (Traktor labels the boot volume with its disk name, which isn't recoverable
// from the path alone; we leave VOLUME empty there. That still round-trips
// within Offcut and resolves on the boot volume.)

export interface TraktorLocation {
  volume: string
  dir: string
  file: string
}

/** Build "/:a/:b/:c/:" from path components [a, b, c]. */
function joinTraktorDir(parts: string[]): string {
  return parts.map((p) => '/:' + p).join('') + '/:'
}

/** Absolute local path → Traktor VOLUME / DIR / FILE. */
export function splitTraktorPath(filePath: string): TraktorLocation {
  if (process.platform === 'win32') {
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
    const volume = parts.shift() ?? '' // "C:"
    const file = parts.pop() ?? ''
    return { volume, dir: joinTraktorDir(parts), file }
  }
  const parts = filePath.split('/').filter(Boolean)
  const file = parts.pop() ?? ''
  if (parts[0] === 'Volumes') {
    const volume = parts[1] ?? ''
    return { volume, dir: joinTraktorDir(parts.slice(2)), file }
  }
  return { volume: '', dir: joinTraktorDir(parts), file }
}

/** The Traktor PRIMARYKEY string for a location: VOLUME + DIR + FILE. */
export function traktorKey(loc: TraktorLocation): string {
  return `${loc.volume}${loc.dir}${loc.file}`
}

/** Traktor VOLUME / DIR / FILE → an absolute local path. */
export function joinTraktorPath(volume: string, dir: string, file: string): string {
  // DIR is "/:" before each component; split it back into plain components.
  const components = dir.split('/:').filter(Boolean)
  if (process.platform === 'win32') {
    const drive = volume || (components.shift() ?? '')
    return `${drive}\\${[...components, file].join('\\')}`
  }
  const inner = [...components, file].join('/')
  if (volume) return `/Volumes/${volume}/${inner}`.replace(/\/{2,}/g, '/')
  return `/${inner}`.replace(/\/{2,}/g, '/')
}
