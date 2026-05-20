import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useWaveformStore, type WaveformStyle } from '../../store/waveformStore'

type SettingsPatch = Partial<AppSettings>

interface PathFieldProps {
  label: string
  description: string
  value: string
  isDirectory?: boolean
  onChange: (v: string) => void
  detected?: string
}

const WAVEFORM_STYLES: { value: WaveformStyle; label: string; desc: string }[] = [
  { value: 'three-band', label: '3-band', desc: 'Rekordbox style — blue / orange / cream layers' },
  { value: 'rgb',        label: 'RGB',    desc: 'Red bass · green mids · blue highs' },
  { value: 'gradient',   label: 'CDJ gradient', desc: 'Spectral colour from centre to tip' },
]

export function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const { style: waveformStyle, setStyle: setWaveformStyle } = useWaveformStore()
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


  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full font-mono text-xs text-muted">
        Loading settings…
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-base font-bold uppercase tracking-[0.12em] text-ink">
            <span className="text-accent mr-2">01</span>settings
          </h1>
          <p className="font-mono text-[10px] text-muted mt-0.5">configure integration paths and preferences</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className={`px-4 py-2 rounded font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
            saved
              ? 'bg-green-600/15 text-green-600 border border-green-600/25'
              : 'bg-accent hover:bg-accent/90 text-paper disabled:opacity-40'
          }`}
        >
          {saving ? 'saving…' : saved ? 'saved' : 'save settings'}
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
        <div className="flex items-start gap-2 font-mono text-[9.5px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>close rekordbox before syncing directly to master.db · sqlcipher direct access available on windows and macos x64 · arm64 support coming soon</span>
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
        <div className="flex items-start gap-2 font-mono text-[9.5px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>Apple Music does not support write-back. Import only.</span>
        </div>
      </Section>

      {/* Engine DJ */}
      <Section title="Engine DJ" icon="◆">
        <PathField
          label="Engine Library database (m.db)"
          description="Used by Pioneer standalone hardware (CDJ-3000, XDJ-XZ, PRIME series) and Algoriddim djay Pro"
          value={settings.engineDjDbPath}
          detected={detected.engineDjDb}
          onChange={(v) => patch({ engineDjDbPath: v })}
          isDirectory={false}
        />
      </Section>

      {/* M3U Playlists */}
      <Section title="M3U Playlists" icon="≡">
        <PathField
          label="Export folder"
          description="Folder where .m3u8 playlist files will be written (one file per playlist)"
          value={settings.m3uExportDir}
          onChange={(v) => patch({ m3uExportDir: v })}
          isDirectory
        />
        <div className="flex items-start gap-2 font-mono text-[9.5px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>M3U export only. Supported by VLC, djay Pro, and most media players.</span>
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

      {/* Waveform */}
      <Section title="Waveform" icon="〰">
        <div className="space-y-2">
          <p className="font-mono text-[9.5px] text-muted uppercase tracking-[0.12em]">colour mode</p>
          <div className="grid grid-cols-3 gap-2">
            {WAVEFORM_STYLES.map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => setWaveformStyle(value)}
                className={`text-left px-3 py-2.5 rounded border transition-colors ${
                  waveformStyle === value
                    ? 'border-accent bg-accent/8 text-ink'
                    : 'border-border/40 text-muted hover:border-border hover:text-ink-soft'
                }`}
              >
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.12em]">{label}</p>
                <p className="font-mono text-[9px] text-muted mt-0.5 leading-tight">{desc}</p>
              </button>
            ))}
          </div>
          <p className="font-mono text-[9px] text-muted/60">takes effect next time a track is loaded</p>
        </div>
      </Section>

      {/* Preferences */}
      <Section title="Preferences" icon="⚙">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[10.5px] text-ink">show welcome screen on startup</p>
              <p className="font-mono text-[9.5px] text-muted mt-0.5">show the getting-started wizard when no library is loaded</p>
            </div>
            <button
              onClick={() => patch({ showWelcomeOnStartup: !settings.showWelcomeOnStartup })}
              className={`w-10 h-6 rounded-full transition-colors relative ${settings.showWelcomeOnStartup ? 'bg-accent' : 'bg-border/60'}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-paper shadow transition-all ${settings.showWelcomeOnStartup ? 'left-5' : 'left-1'}`} />
            </button>
          </div>
        </div>
      </Section>

      {/* Watch Folders */}
      <Section title="Watch Folders" icon="⊙">
        <WatchFoldersTool />
      </Section>

      {/* Path Mappings */}
      <Section title="Path Mappings" icon="⇄">
        <PathMappingTool />
      </Section>

      {/* Quick import shortcuts using saved paths */}
      {(settings.traktorCollectionPath || settings.seratoDir || settings.rekordboxXmlPath || settings.engineDjDbPath) && (
        <Section title="Quick Import" icon="↓">
          <p className="font-mono text-[9.5px] text-muted mb-2">import directly from your detected integrations</p>
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
            {settings.engineDjDbPath && (
              <QuickImportButton
                label="Engine DJ"
                onClick={() => window.api.library.importFromPath('engine-dj', settings.engineDjDbPath)}
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
      <div className="flex items-center gap-2 pb-1 border-b border-border/20">
        <span className="text-accent font-mono text-xs">{icon}</span>
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink">{title}</h2>
      </div>
      <div className="space-y-3 pl-4">{children}</div>
    </section>
  )
}

function PathField({ label, description, value, isDirectory, onChange, detected }: PathFieldProps): JSX.Element {
  const handleChoose = async (): Promise<void> => {
    const p = await window.api.settings.choosePath(label, !!isDirectory)
    if (p) onChange(p)
  }

  return (
    <div className="space-y-1">
      <label className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted block">{label}</label>
      <p className="font-mono text-[9px] text-muted/70">{description}</p>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={detected ? `detected: ${detected.split('/').pop()}` : 'not set'}
          className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[10px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
        />
        <button onClick={handleChoose} className="px-2.5 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[9.5px] text-ink-soft hover:text-ink transition-colors shrink-0">
          browse
        </button>
        {detected && !value && (
          <button onClick={() => onChange(detected)} className="px-2.5 py-1.5 bg-accent/10 hover:bg-accent/20 border border-accent/25 rounded font-mono text-[9.5px] text-accent transition-colors shrink-0">
            use detected
          </button>
        )}
        {value && (
          <button onClick={() => window.api.settings.openInFinder(value)} className="px-2 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[9.5px] text-muted hover:text-ink transition-colors shrink-0" title="Reveal in Finder">
            ↗
          </button>
        )}
      </div>
    </div>
  )
}

function PathMappingTool(): JSX.Element {
  const [from, setFrom] = useState('')
  const [to, setTo]     = useState('')
  const [preview, setPreview] = useState<number | null>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<number | null>(null)

  const handleBrowse = async (which: 'from' | 'to'): Promise<void> => {
    const p = await window.api.settings.choosePath('Select folder', true)
    if (!p) return
    if (which === 'from') { setFrom(p); setPreview(null) }
    else                  { setTo(p);   setPreview(null) }
  }

  const handlePreview = async (): Promise<void> => {
    const count = await window.api.library.previewPathMapping(from, to)
    setPreview(count)
  }

  const handleApply = async (): Promise<void> => {
    if (!window.confirm(`Replace "${from}" → "${to}" in ${preview} track paths? This cannot be undone.`)) return
    setApplying(true)
    const changed = await window.api.library.applyPathMapping(from, to)
    setApplying(false)
    setResult(changed)
    setPreview(null)
  }

  const ready = from.length > 2 && to.length > 2 && from !== to

  return (
    <div className="space-y-3">
      <p className="font-mono text-[9.5px] text-muted/80 leading-relaxed">
        Use when a drive is renamed or your music folder moves. A single mapping fixes all affected track paths at once.
      </p>

      <div className="space-y-2">
        {(['from', 'to'] as const).map((which) => (
          <div key={which} className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] text-muted uppercase tracking-[0.1em] w-7 shrink-0">
              {which === 'from' ? 'old' : 'new'}
            </span>
            <input
              type="text"
              value={which === 'from' ? from : to}
              onChange={(e) => { which === 'from' ? setFrom(e.target.value) : setTo(e.target.value); setPreview(null) }}
              placeholder={which === 'from' ? '/Volumes/OldDrive/Music' : '/Volumes/NewDrive/Music'}
              className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[10px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50"
            />
            <button
              onClick={() => handleBrowse(which)}
              className="px-2.5 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[9.5px] text-ink-soft hover:text-ink transition-colors shrink-0"
            >
              browse
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handlePreview}
          disabled={!ready}
          className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[9.5px] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
        >
          preview
        </button>
        {preview !== null && (
          <button
            onClick={handleApply}
            disabled={applying || preview === 0}
            className="px-3 py-1.5 bg-accent hover:bg-accent/90 text-paper rounded font-mono text-[9.5px] transition-colors disabled:opacity-40"
          >
            {applying ? 'applying…' : `apply to ${preview} tracks`}
          </button>
        )}
        {preview === 0 && (
          <span className="font-mono text-[9.5px] text-muted">no tracks match that path prefix</span>
        )}
        {result !== null && (
          <span className="font-mono text-[9.5px] text-green-600 dark:text-green-400">
            ✓ {result} paths updated
          </span>
        )}
      </div>
    </div>
  )
}

function WatchFoldersTool(): JSX.Element {
  const [folders, setFolders] = useState<string[] | null>(null)

  useEffect(() => {
    window.api.library.getWatchFolders().then(setFolders)
  }, [])

  const update = async (next: string[]): Promise<void> => {
    setFolders(next)
    await window.api.library.setWatchFolders(next)
  }

  const add = async (): Promise<void> => {
    const p = await window.api.settings.choosePath('Select watch folder', true)
    if (!p || folders?.includes(p)) return
    await update([...(folders ?? []), p])
  }

  const remove = async (path: string): Promise<void> => {
    await update((folders ?? []).filter((f) => f !== path))
  }

  if (!folders) return <span className="font-mono text-[9.5px] text-muted">loading…</span>

  return (
    <div className="space-y-3">
      <p className="font-mono text-[9.5px] text-muted/80 leading-relaxed">
        Audio files added to a watched folder are automatically imported into the library. Supports .mp3, .flac, .aiff, .wav, .m4a, .ogg.
      </p>

      {folders.length === 0 ? (
        <p className="font-mono text-[9.5px] text-muted/50 italic">No watch folders configured.</p>
      ) : (
        <ul className="space-y-1.5">
          {folders.map((f) => (
            <li key={f} className="flex items-center gap-2 bg-ink/[0.03] border border-border/30 rounded px-3 py-2">
              <span className="flex-1 font-mono text-[10px] text-ink truncate">{f}</span>
              <button
                onClick={() => window.api.settings.openInFinder(f)}
                className="text-muted hover:text-ink transition-colors font-mono text-[9.5px]"
                title="Reveal in Finder"
              >↗</button>
              <button
                onClick={() => remove(f)}
                className="text-muted hover:text-red-500 transition-colors font-mono text-xs leading-none"
                title="Remove"
              >✕</button>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={add}
        className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[9.5px] text-ink-soft hover:text-ink transition-colors"
      >
        + add folder
      </button>
    </div>
  )
}

function QuickImportButton({ label, onClick }: { label: string; onClick: () => Promise<unknown> }): JSX.Element {
  const [loading, setLoading] = useState(false)
  return (
    <button
      onClick={async () => { setLoading(true); await onClick(); setLoading(false) }}
      disabled={loading}
      className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[10px] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
    >
      {loading ? 'importing…' : `import from ${label}`}
    </button>
  )
}
