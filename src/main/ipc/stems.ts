// Stems IPC — Demucs source separation. Separation is long-running; progress is
// streamed back over `stems:progress` while the handler promise stays pending.

import { ipcMain } from 'electron'
import { loadSettings } from '../settings'
import { cachedStems, clearStems, demucsAvailable, separateStems } from '../stems'
import type { StemSeparateResult, StemsStatus } from '../../shared/types'

export function registerStemHandlers(): void {
  ipcMain.handle('stems:status', async (): Promise<StemsStatus> => {
    const pythonPath = loadSettings().pythonPath?.trim() || 'python3'
    const available = await demucsAvailable(pythonPath)
    return { available, pythonPath }
  })

  ipcMain.handle('stems:cached', (_e, trackId: string) => cachedStems(trackId))

  ipcMain.handle('stems:clear', (_e, trackId: string) => {
    clearStems(trackId)
    return true
  })

  ipcMain.handle(
    'stems:separate',
    async (e, trackId: string, filePath: string): Promise<StemSeparateResult> => {
      const pythonPath = loadSettings().pythonPath?.trim() || 'python3'
      try {
        const paths = await separateStems(trackId, filePath, pythonPath, (percent, label) => {
          if (!e.sender.isDestroyed()) e.sender.send('stems:progress', { trackId, percent, label })
        })
        return { ok: true, paths }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
