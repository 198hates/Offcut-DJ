// Phrase detection IPC — all-in-one structure analysis. Long-running; progress
// streams over `phrase:progress` while the handler promise stays pending.

import { ipcMain } from 'electron'
import { loadSettings } from '../settings'
import { phraseAvailable, detectPhrases } from '../phrase'
import type { PhraseSegment } from '../../shared/types'

export function registerPhraseHandlers(): void {
  ipcMain.handle('phrase:status', async (): Promise<{ available: boolean; pythonPath: string }> => {
    const pythonPath = loadSettings().pythonPath?.trim() || 'python3'
    return { available: await phraseAvailable(pythonPath), pythonPath }
  })

  ipcMain.handle(
    'phrase:detect',
    async (
      e,
      trackId: string,
      filePath: string
    ): Promise<{ ok: true; phrases: PhraseSegment[] } | { ok: false; error: string }> => {
      const pythonPath = loadSettings().pythonPath?.trim() || 'python3'
      try {
        const phrases = await detectPhrases(filePath, pythonPath, (percent, label) => {
          if (!e.sender.isDestroyed()) e.sender.send('phrase:progress', { trackId, percent, label })
        })
        return { ok: true, phrases }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
