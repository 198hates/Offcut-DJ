import { readdirSync, type Dirent } from 'fs'
import { basename, extname, join } from 'path'

/** Extensions Offcut recognizes as audio — shared by import/watch/relink code paths. */
export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.aiff', '.aif', '.wav', '.m4a', '.ogg'])

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTS.has(extname(name).toLowerCase())
}

/** Recursively walks `dir`, returning absolute paths of every audio file found. Skips unreadable dirs. */
export function walkAudioFiles(dir: string): string[] {
  const results: string[] = []
  const walk = (d: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isAudioFile(entry.name)) results.push(full)
    }
  }
  walk(dir)
  return results
}

/** Builds a lowercased-filename → absolute path map across multiple search roots (first match wins). */
export function buildFilenameMap(searchDirs: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const dir of searchDirs) {
    for (const path of walkAudioFiles(dir)) {
      const name = basename(path).toLowerCase()
      if (!map.has(name)) map.set(name, path)
    }
  }
  return map
}
