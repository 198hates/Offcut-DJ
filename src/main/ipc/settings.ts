import { ipcMain, dialog, shell } from 'electron'
import { cpus, totalmem, platform, arch } from 'os'
import { getSettings, saveSettings, getDetectedPaths } from '../settings'
import { isValidLicenceKey } from '../licence'
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

  // ── Licence ───────────────────────────────────────────────────────────────
  ipcMain.handle('licence:status', () => {
    const s = getSettings()
    // Re-validate the stored key, not just the flag — so editing the
    // licenceActivated boolean in settings.json can't bypass the gate, and a
    // rotated build secret invalidates old keys on next launch.
    const activated = !!s.licenceActivated && isValidLicenceKey(s.licenceKey ?? '')
    return { activated, key: s.licenceKey ?? '' }
  })
  ipcMain.handle('licence:activate', (_e, key: string) => {
    const ok = isValidLicenceKey(key)
    if (ok) saveSettings({ licenceKey: (key || '').trim().toUpperCase(), licenceActivated: true })
    return { ok }
  })
  ipcMain.handle('licence:deactivate', () => {
    saveSettings({ licenceKey: '', licenceActivated: false })
    return { ok: true }
  })

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
