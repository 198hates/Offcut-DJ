// Library backup IPC — versioned snapshots + restore.

import { ipcMain } from 'electron'
import { listBackups, createBackup, restoreBackup, deleteBackup, type BackupInfo } from '../backup'

export function registerBackupHandlers(): void {
  ipcMain.handle('backup:list', (): BackupInfo[] => listBackups())
  ipcMain.handle('backup:create', (_e, label?: string): Promise<BackupInfo> => createBackup(label))
  ipcMain.handle('backup:delete', (_e, name: string): boolean => { deleteBackup(name); return true })
  // Restore relaunches the app, so this never resolves to the renderer.
  ipcMain.handle('backup:restore', (_e, name: string): Promise<void> => restoreBackup(name))
}
