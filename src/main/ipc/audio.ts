import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'

export function registerAudioHandlers(): void {
  ipcMain.handle('audio:readFile', async (_e, filePath: string): Promise<ArrayBuffer> => {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
    const buf = await readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })
}
