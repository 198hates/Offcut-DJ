import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerLibraryHandlers } from './ipc/library'
import { registerSettingsHandlers } from './ipc/settings'
import { registerAudioHandlers } from './ipc/audio'
import { registerProLinkHandlers } from './ipc/prolink'
import { warmModel } from './integrations/beat-analysis'
import { startWatcher } from './integrations/watch-folder'
import { loadSettings, saveSettings } from './settings'

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

  autoUpdater.checkForUpdatesAndNotify()

  autoUpdater.on('update-available', () => {
    ipcMain.emit('updater:update-available')
  })

  autoUpdater.on('update-downloaded', () => {
    ipcMain.emit('updater:update-downloaded')
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('co.betweenthebridges.crate')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerLibraryHandlers()
  registerSettingsHandlers()
  registerAudioHandlers()
  registerProLinkHandlers()
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
