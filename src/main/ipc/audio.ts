import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'

interface TagResult {
  bpm: number | null
  key: string | null
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  comment: string | null
}

export function registerAudioHandlers(): void {
  ipcMain.handle('audio:readFile', async (_e, filePath: string): Promise<ArrayBuffer> => {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
    const buf = await readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  ipcMain.handle('audio:readTags', async (_e, filePath: string): Promise<TagResult | null> => {
    if (!existsSync(filePath)) return null
    try {
      const { parseBuffer } = await import('music-metadata')
      const buf = await readFile(filePath)
      const meta = await parseBuffer(buf)
      const c = meta.common
      return {
        bpm: c.bpm ?? null,
        key: c.key ?? null,
        title: c.title ?? null,
        artist: c.artist ?? null,
        album: c.album ?? null,
        genre: c.genre?.[0] ?? null,
        comment: (c.comment as { text: string }[] | undefined)?.[0]?.text ?? null
      }
    } catch {
      return null
    }
  })
}
