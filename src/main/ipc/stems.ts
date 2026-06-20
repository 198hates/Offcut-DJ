// Stems IPC — Demucs source separation. Separation is long-running; progress is
// streamed back over `stems:progress` while the handler promise stays pending.

import { ipcMain } from 'electron'
import { loadSettings } from '../settings'
import { cachedStems, clearStems, demucsAvailable, separateStems } from '../stems'
import { installPack, packStatus, removePack } from '../stems/installer'
import type { StemSeparateResult, StemsStatus } from '../../shared/types'

export function registerStemHandlers(): void {
  ipcMain.handle('stems:status', async (): Promise<StemsStatus> => {
    const pythonPath = loadSettings().pythonPath?.trim() || 'python3'
    const available = await demucsAvailable(pythonPath)
    return { available, pythonPath }
  })

  // ── Stem-engine pack (on-demand download) ──────────────────────────────────
  ipcMain.handle('stems:packStatus', () => packStatus())

  ipcMain.handle('stems:installPack', async (e): Promise<{ ok: boolean; error?: string }> => {
    try {
      await installPack((percent, label) => {
        if (!e.sender.isDestroyed()) e.sender.send('stems:install-progress', { percent, label })
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('stems:removePack', () => {
    removePack()
    return true
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
