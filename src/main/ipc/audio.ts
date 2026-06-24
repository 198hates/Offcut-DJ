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

  /**
   * Decode any audio file to mono 32-bit float PCM via ffmpeg (main process).
   * The renderer's Web Audio `decodeAudioData` cannot decode several formats DJs
   * routinely use (FLAC, AIFF, ALAC/.m4a) and throws "EncodingError" — ffmpeg
   * handles them all. Used by the beatgrid editor.
   *
   * `sampleRate` defaults to 22 050 Hz — plenty for peak rendering and onset
   * detection, and keeps the transferred buffer small (≈5 MB per minute).
   */
  ipcMain.handle(
    'audio:decodePcm',
    async (_e, filePath: string, sampleRate = 22050): Promise<{ samples: Float32Array; sampleRate: number }> => {
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
      const { decodeAudioToPcm } = await import('../integrations/beat-analysis/audio-decode')
      const samples = await decodeAudioToPcm(filePath, sampleRate)
      return { samples, sampleRate }
    }
  )

  /**
   * Compute the audio-similarity fingerprint entirely in the main process and
   * return only the small feature vector. The renderer used to fetch the whole
   * track's PCM via audio:decodePcm and embed it client-side — but that ships
   * ~5 MB/min over IPC per track, which OOMs/fails across a large library run
   * concurrently (the "can't scan most tracks" bug). Doing it here transfers
   * ~43 floats instead. Throws on decode failure so the caller can report it.
   */
  ipcMain.handle('audio:embed', async (_e, filePath: string): Promise<number[]> => {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
    const { decodeAudioToPcm } = await import('../integrations/beat-analysis/audio-decode')
    const { audioFeatureVector } = await import('../../shared/audioFeatures')
    const samples = await decodeAudioToPcm(filePath, 22050)
    return audioFeatureVector(samples, 22050)
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
