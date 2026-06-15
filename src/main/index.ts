import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerLibraryHandlers } from './ipc/library'
import { registerSettingsHandlers } from './ipc/settings'
import { registerAudioHandlers } from './ipc/audio'
import { registerProLinkHandlers } from './ipc/prolink'
import { registerLineageHandlers } from './ipc/lineage'
import { registerStemHandlers } from './ipc/stems'
import { registerAiHandlers } from './ipc/ai'
import { killAllSeparations } from './stems'
import { loadNativeEngine, registerEngineHandlers } from './engine'
import { warmModel } from './integrations/beat-analysis'
import { startWatcher } from './integrations/watch-folder'
import { loadSettings, saveSettings } from './settings'
import { migrateUserDataFromCrate } from './migrate-userdata'

function createWindow(): void {
  const settings = loadSettings()
  const bounds = settings.windowBounds

  const mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Persist window size/position on close
  mainWindow.on('close', () => {
    const [width, height] = mainWindow.getSize()
    const [x, y] = mainWindow.getPosition()
    saveSettings({ windowBounds: { x, y, width, height } })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setupAutoUpdater(): void {
  if (is.dev) return

  // Non-fatal: unsigned/--dir builds have no app-update.yml, and offline
  // launches shouldn't surface an unhandled rejection.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn('[updater] check failed:', (err as Error)?.message ?? err)
  })

  // Send to the renderer windows — `ipcMain.emit` only invokes main-process
  // listeners, so these events used to vanish without reaching the UI.
  const notifyRenderer = (channel: string): void => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send(channel)
    })
  }
  autoUpdater.on('update-available',  () => notifyRenderer('updater:update-available'))
  autoUpdater.on('update-downloaded', () => notifyRenderer('updater:update-downloaded'))
}

app.whenReady().then(() => {
  // One-time: carry library/settings over from the old "Crate" data folder.
  migrateUserDataFromCrate()
  electronApp.setAppUserModelId('co.betweenthebridges.offcut')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerLibraryHandlers()
  registerSettingsHandlers()
  registerAudioHandlers()
  registerProLinkHandlers()
  registerLineageHandlers()
  registerStemHandlers()
  registerAiHandlers()
  registerEngineHandlers()
  loadNativeEngine()    // non-fatal: logs warning if .node not compiled yet
  setupAutoUpdater()
  createWindow()
  warmModel() // preload beat model into memory if installed
  startWatcher(loadSettings().watchFolders)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Demucs separations run for minutes — never leave them orphaned.
  killAllSeparations()
})
