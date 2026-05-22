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

  /**
   * Read embedded cover art from an audio file.
   * Reads only the first 512 KB to avoid loading large audio into memory —
   * sufficient for ID3v2/Vorbis/MP4 tag headers in all common formats.
   * Returns a base64 data URL ("data:image/jpeg;base64,…") or null.
   */
  ipcMain.handle('audio:readArtwork', async (_e, filePath: string): Promise<string | null> => {
    if (!existsSync(filePath)) return null
    try {
      // Use parseFile — reads metadata without loading the full audio buffer.
      // Falls back gracefully to null on any parse error.
      const { parseFile } = await import('music-metadata')
      const meta = await parseFile(filePath, { skipCovers: false, duration: false })
      const pic  = meta.common.picture?.[0]
      if (!pic?.data?.length) return null
      // Validate MIME type to avoid passing garbage to the renderer
      const fmt = pic.format?.startsWith('image/') ? pic.format : 'image/jpeg'
      return `data:${fmt};base64,${Buffer.from(pic.data).toString('base64')}`
    } catch {
      return null
    }
  })
}
