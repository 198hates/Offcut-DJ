import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

export interface AppSettings {
  // Integration paths
  rekordboxXmlPath: string
  rekordboxDbPath: string
  traktorCollectionPath: string
  seratoDir: string
  appleMusicXmlPath: string
  engineDjDbPath: string
  m3uExportDir: string
  // Preferences
  theme: 'dark' | 'light' | 'system'
  defaultExportDir: string
  showWelcomeOnStartup: boolean
  // State
  lastImportedAt: string | null
  windowBounds: { x: number; y: number; width: number; height: number } | null
}

const DEFAULTS: AppSettings = {
  rekordboxXmlPath: '',
  rekordboxDbPath: autoDetectRekordboxDb(),
  traktorCollectionPath: autoDetectTraktorCollection(),
  seratoDir: autoDetectSeratoDir(),
  appleMusicXmlPath: '',
  engineDjDbPath: autoDetectEngineDjDb(),
  m3uExportDir: '',
  theme: 'dark',
  defaultExportDir: '',
  showWelcomeOnStartup: true,
  lastImportedAt: null,
  windowBounds: null
}

// Simple JSON-file settings store (no external dependency)
let _settings: AppSettings | null = null

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  if (_settings) return _settings
  try {
    const data = readFileSync(getSettingsPath(), 'utf8')
    _settings = { ...DEFAULTS, ...JSON.parse(data) }
  } catch {
    _settings = { ...DEFAULTS }
  }
  return _settings!
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  _settings = { ...(loadSettings()), ...patch }
  try {
    writeFileSync(getSettingsPath(), JSON.stringify(_settings, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to save settings:', err)
  }
  return _settings
}

export function getSettings(): AppSettings {
  return loadSettings()
}

// ── Auto-detection helpers ────────────────────────────────────────────────────

function autoDetectRekordboxDb(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.APPDATA ?? '', 'Pioneer', 'rekordbox', 'master.db')]
      : [join(home, 'Library', 'Pioneer', 'rekordbox', 'master.db')]
  return candidates.find(existsSync) ?? ''
}

export function autoDetectTraktorCollection(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const base =
    process.platform === 'win32'
      ? join(home, 'Documents', 'Native Instruments')
      : join(home, 'Documents', 'Native Instruments')

  for (const version of ['Traktor Pro 3', 'Traktor Pro 2', 'Traktor']) {
    const p = join(base, version, 'collection.nml')
    if (existsSync(p)) return p
  }
  return ''
}

export function autoDetectSeratoDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'Music', '_Serato_')]
      : [join(home, 'Music', '_Serato_')]
  return candidates.find(existsSync) ?? ''
}

export function autoDetectAppleMusicXml(): string {
  const home = process.env.HOME ?? ''
  if (process.platform !== 'darwin') {
    const win = join(process.env.USERPROFILE ?? '', 'Music', 'iTunes', 'iTunes Music Library.xml')
    return existsSync(win) ? win : ''
  }
  // macOS: user must export manually, but check the default location
  const candidate = join(home, 'Music', 'Music', 'Library.xml')
  return existsSync(candidate) ? candidate : ''
}

export function autoDetectEngineDjDb(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const candidate =
    process.platform === 'win32'
      ? join(home, 'Music', 'Engine Library', 'Database2', 'm.db')
      : join(home, 'Music', 'Engine Library', 'Database2', 'm.db')
  return existsSync(candidate) ? candidate : ''
}

export function getDetectedPaths(): Record<string, string> {
  return {
    rekordboxDb: autoDetectRekordboxDb(),
    traktorCollection: autoDetectTraktorCollection(),
    seratoDir: autoDetectSeratoDir(),
    appleMusicXml: autoDetectAppleMusicXml(),
    engineDjDb: autoDetectEngineDjDb()
  }
}
