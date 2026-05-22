import chokidar, { type FSWatcher } from 'chokidar'
import { parseBuffer } from 'music-metadata'
import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { BrowserWindow } from 'electron'
import { getLibraryDb, insertOrUpdateTrack } from '../../library/db'
import type { Track } from '../../../shared/types'

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.aiff', '.aif', '.wav', '.m4a', '.ogg'])

let watcher: FSWatcher | null = null

async function importFile(filePath: string): Promise<void> {
  const db = getLibraryDb()
  if (db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(filePath)) return

  try {
    const buf = await readFile(filePath)
    const meta = await parseBuffer(buf)
    const c = meta.common
    const f = meta.format

    const track: Track = {
      id: randomUUID(),
      filePath,
      title: c.title || basename(filePath, extname(filePath)),
      artist: c.artist || '',
      album: c.album || '',
      genre: c.genre?.[0] || '',
      bpm: c.bpm ?? null,
      key: c.key ?? null,
      durationSeconds: f.duration ?? null,
      rating: 0,
      color: '',
      energy: null,
      danceability: null,
          mood: null,
          analysedBeatgrid: null,
          editLineage: null,
      playCount: 0,
      lastPlayedAt: null,
      dateAdded: new Date().toISOString(),
      comment: (c.comment as { text: string }[] | undefined)?.[0]?.text ?? '',
      tags: [],
      customTags: {},
      cuePoints: [],
      beatgrid: [],
      sourceIds: {}
    }

    insertOrUpdateTrack(db, track)

    BrowserWindow.getAllWindows().forEach((win) =>
      win.webContents.send('library:watchFolderAdded')
    )
  } catch (err) {
    console.error(`[watch-folder] failed to import ${filePath}:`, err)
  }
}

export function startWatcher(paths: string[]): void {
  watcher?.close()
  watcher = null
  if (!paths.length) return

  watcher = chokidar.watch(paths, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })

  watcher.on('add', (filePath) => {
    if (AUDIO_EXTS.has(extname(filePath).toLowerCase())) {
      importFile(filePath)
    }
  })
}

export function stopWatcher(): void {
  watcher?.close()
  watcher = null
}
