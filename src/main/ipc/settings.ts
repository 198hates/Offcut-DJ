import { ipcMain, dialog, shell } from 'electron'
import { cpus, totalmem, platform, arch } from 'os'
import { getSettings, saveSettings, getDetectedPaths } from '../settings'
import type { AppSettings } from '../settings'
import type { SystemInfo } from '../../shared/types'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    // `aiUsage` is owned by the main process — it's recorded per AI call and
    // zeroed via ai:resetUsage. A renderer "Save settings" carries whatever
    // aiUsage it loaded at mount, which would clobber newer spend (or undo a
    // reset). Strip it so only the AI pipeline writes it.
    const { aiUsage: _ignore, ...rest } = patch
    void _ignore
    return saveSettings(rest)
  })

  ipcMain.handle('settings:getDetectedPaths', () => getDetectedPaths())

  ipcMain.handle('settings:systemInfo', (): SystemInfo => ({
    cpuCount: cpus().length || 4,
    totalMemGB: Math.round(totalmem() / 1024 ** 3),
    platform: platform(),
    arch: arch()
  }))

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
