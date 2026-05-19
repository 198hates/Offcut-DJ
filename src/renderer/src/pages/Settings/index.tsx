import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

type SettingsPatch = Partial<AppSettings>

interface PathFieldProps {
  label: string
  description: string
  value: string
  isDirectory?: boolean
  onChange: (v: string) => void
  detected?: string
}

export function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [detected, setDetected] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    Promise.all([
      window.api.settings.get(),
      window.api.settings.getDetectedPaths()
    ]).then(([s, d]) => {
      setSettings(s)
      setDetected(d)
    })
  }, [])

  const patch = (p: SettingsPatch): void => {
    setSettings((s) => (s ? { ...s, ...p } : s))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    if (!settings) return
    setSaving(true)
    await window.api.settings.save(settings)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const choose = async (key: keyof AppSettings, title: string, isDir: boolean): Promise<void> => {
    const p = await window.api.settings.choosePath(title, isDir)
    if (p) patch({ [key]: p } as SettingsPatch)
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full text-white/30 text-sm">
        Loading settings…
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Settings</h1>
          <p className="text-sm text-white/40 mt-0.5">Configure integration paths and preferences</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? 'bg-green-600/20 text-green-400 border border-green-600/30'
              : 'bg-accent hover:bg-accent-hover text-white disabled:opacity-40'
          }`}
        >
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>

      {/* Rekordbox */}
      <Section title="Rekordbox" icon="◈">
        <PathField
          label="Library XML"
          description="Exported via File › Export Collection in xml format in Rekordbox"
          value={settings.rekordboxXmlPath}
          onChange={(v) => patch({ rekordboxXmlPath: v })}
          isDirectory={false}
        />
        <PathField
          label="master.db (direct access)"
          description="Enables direct Rekordbox database sync without XML export"
          value={settings.rekordboxDbPath}
          detected={detected.rekordboxDb}
          onChange={(v) => patch({ rekordboxDbPath: v })}
          isDirectory={false}
        />
        <div className="flex items-start gap-2 text-xs text-white/40 bg-white/[0.03] border border-white/10 rounded-lg p-3">
          <span className="shrink-0">ℹ</span>
          <span>Close Rekordbox before syncing directly to master.db. SQLCipher direct access is available on Windows and macOS x64. ARM64 support coming soon.</span>
        </div>
      </Section>

      {/* Traktor */}
      <Section title="Traktor Pro" icon="◉">
        <PathField
          label="collection.nml"
          description="Your Traktor library file (auto-detected if installed)"
          value={settings.traktorCollectionPath}
          detected={detected.traktorCollection}
          onChange={(v) => patch({ traktorCollectionPath: v })}
          isDirectory={false}
        />
      </Section>

      {/* Serato */}
      <Section title="Serato DJ" icon="◎">
        <PathField
          label="_Serato_ folder"
          description="The root Serato folder containing Subcrates (usually ~/Music/_Serato_)"
          value={settings.seratoDir}
          detected={detected.seratoDir}
          onChange={(v) => patch({ seratoDir: v })}
          isDirectory
        />
      </Section>

      {/* Apple Music */}
      <Section title="Apple Music" icon="♪">
        <PathField
          label="Library.xml"
          description="Export via File › Library › Export Library… in Music.app"
          value={settings.appleMusicXmlPath}
          detected={detected.appleMusicXml}
          onChange={(v) => patch({ appleMusicXmlPath: v })}
          isDirectory={false}
        />
        <div className="flex items-start gap-2 text-xs text-white/40 bg-white/[0.03] border border-white/10 rounded-lg p-3">
          <span className="shrink-0">ℹ</span>
          <span>Apple Music does not support write-back. Import only.</span>
        </div>
      </Section>

      {/* Export defaults */}
      <Section title="Export Defaults" icon="↑">
        <PathField
          label="Default export folder"
          description="Where exported files are saved by default"
          value={settings.defaultExportDir}
          onChange={(v) => patch({ defaultExportDir: v })}
          isDirectory
        />
      </Section>

      {/* Preferences */}
      <Section title="Preferences" icon="⚙">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white">Show welcome screen on startup</p>
              <p className="text-xs text-white/40">Show the getting-started wizard when no library is loaded</p>
            </div>
            <button
              onClick={() => patch({ showWelcomeOnStartup: !settings.showWelcomeOnStartup })}
              className={`w-10 h-6 rounded-full transition-colors relative ${settings.showWelcomeOnStartup ? 'bg-accent' : 'bg-white/10'}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${settings.showWelcomeOnStartup ? 'left-5' : 'left-1'}`} />
            </button>
          </div>
        </div>
      </Section>

      {/* Quick import shortcuts using saved paths */}
      {(settings.traktorCollectionPath || settings.seratoDir || settings.rekordboxXmlPath) && (
        <Section title="Quick Import" icon="↓">
          <p className="text-xs text-white/40 mb-2">Import directly from your detected integrations</p>
          <div className="flex flex-wrap gap-2">
            {settings.rekordboxXmlPath && (
              <QuickImportButton
                label="Rekordbox XML"
                onClick={() => window.api.library.importFromPath('rekordbox', settings.rekordboxXmlPath)}
              />
            )}
            {settings.traktorCollectionPath && (
              <QuickImportButton
                label="Traktor"
                onClick={() => window.api.library.importFromPath('traktor', settings.traktorCollectionPath)}
              />
            )}
            {settings.seratoDir && (
              <QuickImportButton
                label="Serato"
                onClick={() => window.api.library.importFromPath('serato', settings.seratoDir)}
              />
            )}
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-accent text-sm">{icon}</span>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="space-y-3 pl-5">{children}</div>
    </section>
  )
}

function PathField({ label, description, value, isDirectory, onChange, detected }: PathFieldProps): JSX.Element {
  const handleChoose = async (): Promise<void> => {
    const p = await window.api.settings.choosePath(label, !!isDirectory)
    if (p) onChange(p)
  }

  const useDetected = (): void => {
    if (detected) onChange(detected)
  }

  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-white/60">{label}</label>
      <p className="text-xs text-white/30">{description}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={detected ? `Auto-detected: ${detected.split('/').pop()}` : 'Not set'}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-accent transition-colors font-mono placeholder-white/20"
        />
        <button
          onClick={handleChoose}
          className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/60 hover:text-white transition-colors shrink-0"
        >
          Browse
        </button>
        {detected && !value && (
          <button
            onClick={useDetected}
            className="px-3 py-1.5 bg-accent/20 hover:bg-accent/30 border border-accent/30 rounded-lg text-xs text-accent transition-colors shrink-0"
          >
            Use detected
          </button>
        )}
        {value && (
          <button
            onClick={() => window.api.settings.openInFinder(value)}
            className="px-2 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs text-white/40 hover:text-white transition-colors shrink-0"
            title="Reveal in Finder"
          >
            ↗
          </button>
        )}
      </div>
    </div>
  )
}

function QuickImportButton({ label, onClick }: { label: string; onClick: () => Promise<unknown> }): JSX.Element {
  const [loading, setLoading] = useState(false)
  return (
    <button
      onClick={async () => { setLoading(true); await onClick(); setLoading(false) }}
      disabled={loading}
      className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 hover:text-white transition-colors disabled:opacity-40"
    >
      {loading ? 'Importing…' : `Import from ${label}`}
    </button>
  )
}
