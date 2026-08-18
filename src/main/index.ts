import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { registerLibraryHandlers } from './ipc/library'
import { registerSettingsHandlers } from './ipc/settings'
import { registerAudioHandlers } from './ipc/audio'
import { registerLineageHandlers } from './ipc/lineage'
import { registerStemHandlers } from './ipc/stems'
import { registerBackupHandlers } from './ipc/backup'
import { registerAiHandlers } from './ipc/ai'
import { registerSyncHandlers, startSyncServerIfEnabled, stopSyncServer } from './ipc/sync'
import { killAllSeparations } from './stems'
import { loadNativeEngine, registerEngineHandlers } from './engine'
import { registerCastHandlers } from './cast'
import { warmModel } from './integrations/beat-analysis'
import { startWatcher } from './integrations/watch-folder'
import { loadSettings, saveSettings } from './settings'
import { migrateUserDataFromCrate } from './migrate-userdata'
import { prepareLibrary } from './library/db'
import {
  prepareMaintenanceSplash, reportMaintenancePhase, closeMaintenanceSplash
} from './maintenance-splash'

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

const RELEASE_TAG_URL = 'https://github.com/198hates/Offcut-DJ/releases/tag/v'

interface AvailableUpdate {
  version: string
  /** Non-null only on macOS, which must be sent to the release page to install by hand. */
  downloadUrl: string | null
}

/**
 * Last update the check found, held so a renderer that mounts *after* the check
 * can still see it. The check resolves a second or two into launch, which is
 * reliably before React mounts and subscribes — so a fire-and-forget
 * `webContents.send` alone is lost every time.
 */
let availableUpdate: AvailableUpdate | null = null

function setupAutoUpdater(): void {
  // Registered unconditionally: the renderer asks on mount regardless, and in
  // dev there is simply never an update to report.
  ipcMain.handle('updater:getAvailable', () => availableUpdate)

  if (is.dev) return

  // macOS can never self-install. Squirrel.Mac verifies the *running* app's
  // code signature and Offcut ships unsigned (`identity: null`), so the install
  // step always dies with "Could not get code signature for running
  // application" — on Apple Silicon and Intel alike, since the check is on the
  // running app rather than the download. Measured 2026-08-17: a 1.0.5 install
  // found 1.0.7, pulled the whole ~190 MB zip, then failed at that step and was
  // still 1.0.5 after quitting. Worse, the throw happens before
  // `dispatchUpdateDownloaded`, so the UI never even heard about it.
  //
  // So on macOS: don't download, just tell the renderer where to get it. Other
  // platforms are unaffected — NSIS and AppImage install fine unsigned, so they
  // keep the normal download-and-install-on-quit flow.
  const isMac = process.platform === 'darwin'
  if (isMac) autoUpdater.autoDownload = false

  // Non-fatal: unsigned/--dir builds have no app-update.yml, and offline
  // launches shouldn't surface an unhandled rejection.
  const check = isMac
    ? autoUpdater.checkForUpdates() // notify-on-download is moot with autoDownload off
    : autoUpdater.checkForUpdatesAndNotify()
  check.catch((err) => {
    console.warn('[updater] check failed:', (err as Error)?.message ?? err)
  })

  // Send to the renderer windows — `ipcMain.emit` only invokes main-process
  // listeners, so these events used to vanish without reaching the UI.
  const notifyRenderer = (channel: string, payload?: unknown): void => {
    BrowserWindow.getAllWindows().forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    })
  }
  autoUpdater.on('update-available', (info) => {
    availableUpdate = {
      version: info?.version ?? '',
      // Only macOS needs the manual route; elsewhere the download is already
      // under way and the user shouldn't be sent to a browser.
      downloadUrl: isMac ? `${RELEASE_TAG_URL}${info?.version ?? ''}` : null
    }
    notifyRenderer('updater:update-available', availableUpdate)
  })
  autoUpdater.on('update-downloaded', () => notifyRenderer('updater:update-downloaded'))
}

app.whenReady().then(async () => {
  // One-time: carry library/settings over from the old "Crate" data folder.
  migrateUserDataFromCrate()
  electronApp.setAppUserModelId('com.offcut.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // registerLibraryHandlers() opens the database, which is where one-time
  // maintenance runs — up to ~95s of synchronous SQLite on a big library, with
  // the main process blocked throughout. Load a splash FIRST (it cannot be
  // loaded once we're blocked) and let the DB layer drive it. It stays hidden
  // unless a phase actually reports, so an ordinary launch shows nothing.
  try {
    await prepareMaintenanceSplash()
    // yieldToUi gives the main thread a real run-loop turn so the splash is
    // actually painted before we vanish into a blocking phase. Without it the
    // window is created and "visible" but never reaches the screen.
    await prepareLibrary(reportMaintenancePhase, () => new Promise((r) => setTimeout(r, 180)))
  } catch (err) {
    console.error('[startup] library preparation failed:', (err as Error).message)
  } finally {
    // Always tear down, even if preparation threw — a stuck splash with no main
    // window would leave the app unusable and unquittable.
    closeMaintenanceSplash()
  }
  registerLibraryHandlers()

  registerSettingsHandlers()
  registerAudioHandlers()
  registerLineageHandlers()
  registerStemHandlers()
  registerBackupHandlers()
  registerAiHandlers()
  registerSyncHandlers()
  registerEngineHandlers()
  registerCastHandlers()
  loadNativeEngine()    // non-fatal: logs warning if .node not compiled yet
  setupAutoUpdater()
  createWindow()
  startupComplete = true
  warmModel() // preload beat model into memory if installed
  startWatcher(loadSettings().watchFolders)
  void startSyncServerIfEnabled() // resume phone-sync if it was left on

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * The maintenance splash is a real BrowserWindow, and closing it happens BEFORE
 * the main window is created. Without this guard that moment counts as "all
 * windows closed" and quits the app outright on Windows and Linux — the app
 * would appear to launch and immediately vanish, and only for users whose
 * library needed migrating.
 */
let startupComplete = false

app.on('window-all-closed', () => {
  if (!startupComplete) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Demucs separations run for minutes — never leave them orphaned.
  killAllSeparations()
  void stopSyncServer()
})
