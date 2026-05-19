import { ipcMain, dialog, shell } from 'electron'
import { getSettings, saveSettings, getDetectedPaths } from '../settings'
import type { AppSettings } from '../settings'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  ipcMain.handle('settings:getDetectedPaths', () => getDetectedPaths())

  ipcMain.handle('settings:choosePath', async (_e, title: string, isDirectory: boolean) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: isDirectory ? ['openDirectory'] : ['openFile']
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('settings:openInFinder', (_e, path: string) => {
    shell.showItemInFolder(path)
  })
}
