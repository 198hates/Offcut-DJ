import { useEffect, useState, useCallback, createContext, useContext } from 'react'
import type { AppSettings, SystemInfo } from '@shared/types'
import { suggestConcurrency } from '../../lib/concurrency'
import { CueTemplateEditor } from '../../components/CueTemplateEditor'
import { useWaveformStore, type WaveformStyle, type KeyNotation } from '../../store/waveformStore'
import { useThemeStore } from '../../store/themeStore'
import { MidiSettings } from '../../components/MidiSettings'
import { AI_SETTINGS_CHANGED } from '../../hooks/useAiStatus'
import { tabClass } from '../../lib/ui'

type SettingsPatch = Partial<AppSettings>

// ── Settings categories ───────────────────────────────────────────────────────
// The page is split into a few tabs so each view shows only a handful of
// sections instead of one long scroll. Each <Section> declares its category and
// hides itself unless that tab is active (see CategoryContext below).
type SettingsCategory = 'integrations' | 'ai' | 'playback' | 'library' | 'general'

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: 'integrations', label: 'Integrations' },
  { id: 'ai', label: 'AI & Discovery' },
  { id: 'playback', label: 'Playback' },
  { id: 'library', label: 'Library' },
  { id: 'general', label: 'General' }
]

const CategoryContext = createContext<SettingsCategory>('integrations')

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
  const [activeCat, setActiveCat] = useState<SettingsCategory>('integrations')
  const {
    style: waveformStyle, setStyle: setWaveformStyle,
    keyNotation, setKeyNotation,
    autoGainEnabled, setAutoGainEnabled,
  } = useWaveformStore()
  const { theme: currentTheme, toggleTheme } = useThemeStore()
  const [detected, setDetected] = useState<Record<string, string>>({})
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const applyTheme = useCallback((t: 'dark' | 'light' | 'system') => {
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      // Apply system preference but keep themeStore in sync
      document.documentElement.classList.toggle('dark', prefersDark)
      document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light'
    } else if (t !== currentTheme) {
      toggleTheme()  // toggleTheme flips between light/dark
    }
  }, [currentTheme, toggleTheme])

  useEffect(() => {
    Promise.all([
      window.api.settings.get(),
      window.api.settings.getDetectedPaths()
    ]).then(([s, d]) => {
      setSettings(s)
      setDetected(d)
    })
    window.api.settings.systemInfo().then(setSysInfo).catch(() => setSysInfo(null))
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
    // Let AI-gated UI (Search, SetBuilder, SmartFixes) refresh immediately.
    window.dispatchEvent(new Event(AI_SETTINGS_CHANGED))
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
            <span className="text-accent mr-2">⚙</span>settings
          </h1>
          <p className="font-mono text-[13px] text-muted mt-0.5">configure integration paths and preferences</p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className={`px-4 py-2 rounded font-mono text-[13px] uppercase tracking-[0.12em] transition-colors ${
            saved
              ? 'bg-green-600/15 text-green-600 border border-green-600/25'
              : 'bg-accent hover:bg-accent/90 text-paper disabled:opacity-40'
          }`}
        >
          {saving ? 'saving…' : saved ? 'saved' : 'save settings'}
        </button>
      </div>

      {/* Category tabs */}
      <div className="sticky top-0 z-10 -mx-6 px-6 py-2 bg-chassis/95 backdrop-blur border-b border-border/25 flex flex-wrap gap-1">
        {CATEGORIES.map((c) => (
          <button key={c.id} onClick={() => setActiveCat(c.id)} className={tabClass(activeCat === c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <CategoryContext.Provider value={activeCat}>

      {/* Rekordbox */}
      <Section title="Rekordbox" icon="◈" category="integrations">
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
        <div className="flex items-start gap-2 font-mono text-[12px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>close rekordbox before syncing directly to master.db · sqlcipher direct access available on windows and macos x64 · arm64 support coming soon</span>
        </div>
      </Section>

      {/* Traktor */}
      <Section title="Traktor Pro" icon="◉" category="integrations">
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
      <Section title="Serato DJ" icon="◎" category="integrations">
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
      <Section title="Apple Music" icon="♪" category="integrations">
        <PathField
          label="Library.xml"
          description="Export via File › Library › Export Library… in Music.app"
          value={settings.appleMusicXmlPath}
          detected={detected.appleMusicXml}
          onChange={(v) => patch({ appleMusicXmlPath: v })}
          isDirectory={false}
        />
        <div className="flex items-start gap-2 font-mono text-[12px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>Apple Music does not support write-back. Import only.</span>
        </div>
      </Section>

      {/* Engine DJ */}
      <Section title="Engine DJ" icon="◆" category="integrations">
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
      <Section title="M3U Playlists" icon="≡" category="integrations">
        <PathField
          label="Export folder"
          description="Folder where .m3u8 playlist files will be written (one file per playlist)"
          value={settings.m3uExportDir}
          onChange={(v) => patch({ m3uExportDir: v })}
          isDirectory
        />
        <div className="flex items-start gap-2 font-mono text-[12px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>M3U export only. Supported by VLC, djay Pro, and most media players.</span>
        </div>
      </Section>

      {/* Lineage */}
      <Section title="Lineage" icon="⛏" category="ai">
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            Discogs personal access token
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Optional — discovery works without one but unauthenticated requests are slower (lower rate
            limit). A free token raises the limit. Generate one at discogs.com › Settings › Developers.
          </p>
          <input
            type="password"
            value={settings.discogsToken}
            onChange={(e) => patch({ discogsToken: e.target.value })}
            placeholder="not set — running unauthenticated"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
        </div>
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            AcoustID application key
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Used for fingerprint-based track identity. A shared default ships with the app; override with
            your own free key from acoustid.org if you hit limits.
          </p>
          <input
            type="text"
            value={settings.acoustidKey}
            onChange={(e) => patch({ acoustidKey: e.target.value })}
            placeholder="acoustid application key"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
        </div>
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            Last.fm API key
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Enables the “listeners also play” discovery route — Last.fm’s collaborative similarity data.
            Free key from last.fm › api › account. Leave blank to skip that route.
          </p>
          <input
            type="text"
            value={settings.lastfmKey}
            onChange={(e) => patch({ lastfmKey: e.target.value })}
            placeholder="not set — listener route disabled"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
        </div>
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            1001Tracklists partner API
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Enables the “played alongside” route (DJ-set co-play). There is no open 1001TL API — this needs
            their commercial/partner credentials. Leave blank to skip the route.
          </p>
          <input
            type="text"
            value={settings.tracklistsApiBase}
            onChange={(e) => patch({ tracklistsApiBase: e.target.value })}
            placeholder="partner API base URL (optional)"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
          <input
            type="password"
            value={settings.tracklistsApiKey}
            onChange={(e) => patch({ tracklistsApiKey: e.target.value })}
            placeholder="partner API key (optional)"
            spellCheck={false}
            autoComplete="off"
            className="w-full mt-1.5 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
          <label className="flex items-center gap-2 pt-1.5 font-mono text-[12px] text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={settings.enableTracklistsScrape}
              onChange={(e) => patch({ enableTracklistsScrape: e.target.checked })}
              className="accent-accent"
            />
            Allow public fallback (fragile, best-effort — returns nothing rather than failing)
          </label>
        </div>
        <div className="flex items-start gap-2 font-mono text-[12px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>
            Keys are stored locally in your settings file and only used by the main process. Save settings
            after editing, then re-open Lineage for changes to take effect.
          </span>
        </div>
      </Section>

      {/* AI */}
      <Section title="AI" icon="✦" category="ai">
        <label className="flex items-center gap-2 font-mono text-[12px] text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={settings.aiEnabled ?? false}
            onChange={(e) => patch({ aiEnabled: e.target.checked })}
            className="accent-accent"
          />
          Enable AI features
        </label>
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            Anthropic API key
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Required for AI features (natural-language search, set building). Get one from
            console.anthropic.com. Stored locally and only used by the main process.
          </p>
          <input
            type="password"
            value={settings.anthropicApiKey ?? ''}
            onChange={(e) => patch({ anthropicApiKey: e.target.value })}
            placeholder="sk-ant-…"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
        </div>
        <div className="flex items-start gap-2 font-mono text-[12px] text-muted bg-ink/[0.03] border border-border/30 rounded p-3">
          <span className="shrink-0 text-accent">ℹ</span>
          <span>
            Privacy: AI features send only track <em>metadata</em> (titles, BPM, key, energy…) to
            Anthropic — never your audio. The key never leaves the main process. Save settings after
            editing.
          </span>
        </div>
      </Section>

      {/* Stems */}
      <Section title="Stems (Demucs)" icon="◫" category="playback">
        <div className="space-y-1">
          <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">
            Python executable
          </label>
          <p className="font-mono text-[12px] text-muted/70">
            Stem separation shells out to Demucs. Install it once with{' '}
            <span className="text-accent">pip install demucs soundfile</span>, then point this at the Python that has it
            (e.g. a venv’s <span className="text-accent">bin/python</span>). Separation runs once per track and is
            cached. Toggle <span className="text-accent">STEMS</span> on a deck to separate.
          </p>
          <input
            type="text"
            value={settings.pythonPath}
            onChange={(e) => patch({ pythonPath: e.target.value })}
            placeholder="python3"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
          />
        </div>
      </Section>

      {/* Export defaults */}
      <Section title="Export Defaults" icon="↑" category="library">
        <PathField
          label="Default export folder"
          description="Where exported files are saved by default"
          value={settings.defaultExportDir}
          onChange={(v) => patch({ defaultExportDir: v })}
          isDirectory
        />
      </Section>

      {/* Waveform */}
      <Section title="Waveform" icon="〰" category="playback">
        <div className="space-y-2">
          <p className="font-mono text-[12px] text-muted uppercase tracking-[0.12em]">colour mode</p>
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
                <p className="font-mono text-[13px] font-bold uppercase tracking-[0.12em]">{label}</p>
                <p className="font-mono text-[12px] text-muted mt-0.5 leading-tight">{desc}</p>
              </button>
            ))}
          </div>
          <p className="font-mono text-[12px] text-muted/60">takes effect next time a track is loaded</p>
        </div>

        {/* Key notation */}
        <div className="space-y-2">
          <p className="font-mono text-[12px] text-muted uppercase tracking-[0.12em]">key notation</p>
          <div className="flex gap-2">
            {([
              { value: 'camelot',  label: 'Camelot', example: '8A' },
              { value: 'openkey',  label: 'Open Key', example: '8m' },
              { value: 'standard', label: 'Standard', example: 'Bbm' },
            ] as { value: KeyNotation; label: string; example: string }[]).map(({ value, label, example }) => (
              <button
                key={value}
                onClick={() => setKeyNotation(value)}
                className={`flex-1 text-center px-3 py-2.5 rounded border transition-colors ${
                  keyNotation === value
                    ? 'border-accent bg-accent/8 text-ink'
                    : 'border-border/40 text-muted hover:border-border hover:text-ink-soft'
                }`}
              >
                <p className="font-mono text-[13px] font-bold uppercase tracking-[0.12em]">{label}</p>
                <p className="font-mono text-[12px] text-muted mt-0.5">{example}</p>
              </button>
            ))}
          </div>
          <p className="font-mono text-[12px] text-muted/60">how keys are displayed in the library and deck headers</p>
        </div>
      </Section>

      {/* Preferences */}
      <Section title="Preferences" icon="⚙" category="general">
        <div className="space-y-4">
          {/* Theme */}
          <div>
            <p className="font-mono text-[13px] text-ink mb-1.5">colour scheme</p>
            <div className="flex gap-2">
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button key={t}
                  onClick={() => applyTheme(t)}
                  className={`font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border transition-colors
                    ${currentTheme === t
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-border/30 text-muted hover:text-ink hover:border-border/60'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="font-mono text-[12px] text-muted/60 mt-1">'system' follows your OS light/dark preference</p>
          </div>

          {/* Auto-gain */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[13px] text-ink">auto-gain normalisation</p>
              <p className="font-mono text-[12px] text-muted mt-0.5">apply per-track gain trim on deck load to match loudness · requires gain_db to be analysed</p>
            </div>
            <button
              onClick={() => setAutoGainEnabled(!autoGainEnabled)}
              className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${autoGainEnabled ? 'bg-accent' : 'bg-border/60'}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-paper shadow transition-all ${autoGainEnabled ? 'left-5' : 'left-1'}`} />
            </button>
          </div>

          {/* Welcome screen */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[13px] text-ink">show welcome screen on startup</p>
              <p className="font-mono text-[12px] text-muted mt-0.5">show the getting-started wizard when no library is loaded</p>
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

      {/* Performance / Analysis */}
      <Section title="Performance" icon="⚡" category="general">
        {(() => {
          const suggested = sysInfo ? suggestConcurrency(sysInfo.cpuCount, sysInfo.totalMemGB) : 4
          const current = settings.analysisConcurrency ?? 0
          const effective = current > 0 ? current : suggested
          const set = (n: number): void => patch({ analysisConcurrency: Math.max(0, Math.min(16, n)) })
          return (
            <div className="space-y-4">
              <div>
                <p className="font-mono text-[13px] text-ink mb-0.5">analysis concurrency</p>
                <p className="font-mono text-[12px] text-muted mb-2">
                  how many tracks are analysed at once (BPM/key, energy, beat grid, audio similarity, loudness, phrases).
                  higher is faster but uses more CPU and RAM — each in-flight track holds a decoded buffer.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => set(current === 0 ? Math.max(1, effective - 1) : current - 1)}
                    className="font-mono text-[14px] w-8 h-8 rounded border border-border/30 text-muted hover:text-ink hover:border-border/60 transition-colors"
                  >−</button>
                  <div className="font-mono text-[13px] text-ink min-w-[140px] text-center px-3 py-1.5 rounded border border-border/30 bg-paper/40">
                    {current === 0 ? `auto · ${suggested}` : current}
                  </div>
                  <button
                    onClick={() => set(current === 0 ? effective + 1 : current + 1)}
                    className="font-mono text-[14px] w-8 h-8 rounded border border-border/30 text-muted hover:text-ink hover:border-border/60 transition-colors"
                  >+</button>
                  <button
                    onClick={() => set(0)}
                    className={`font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border transition-colors
                      ${current === 0
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-border/30 text-muted hover:text-ink hover:border-border/60'}`}
                  >auto</button>
                </div>
              </div>

              <div className="rounded border border-border/30 bg-paper/40 p-3 space-y-1">
                <p className="font-mono text-[12px] text-muted">
                  detected:{' '}
                  <span className="text-ink">
                    {sysInfo ? `${sysInfo.cpuCount} cores · ${sysInfo.totalMemGB} GB · ${sysInfo.arch}` : 'reading…'}
                  </span>
                  {sysInfo && <> → suggested <span className="text-accent">{suggested}</span></>}
                </p>
                <p className="font-mono text-[11px] text-muted/60">
                  rough guide — laptop / 8 GB: 2–3 · desktop / 16 GB: 4–6 · workstation / 32 GB+: 6–8
                </p>
              </div>
            </div>
          )
        })()}
      </Section>

      {/* Auto-cue templates */}
      <Section title="Auto-cue templates" icon="⚑" category="general">
        <CueTemplateEditor settings={settings} patch={patch} />
      </Section>

      {/* Pre-listen / Headphone cue */}
      <Section title="Pre-listen (Cue)" icon="🎧" category="playback">
        <PreListenSettings />
      </Section>

      {/* Watch Folders */}
      <Section title="Watch Folders" icon="⊙" category="library">
        <WatchFoldersTool />
      </Section>

      {/* Path Mappings */}
      <Section title="Path Mappings" icon="⇄" category="library">
        <PathMappingTool />
      </Section>

      {/* MIDI Controllers */}
      <Section title="MIDI Controllers" icon="◈" category="general">
        <MidiSettings />
      </Section>

      {/* Quick import shortcuts using saved paths */}
      {(settings.traktorCollectionPath || settings.seratoDir || settings.rekordboxXmlPath || settings.engineDjDbPath) && (
        <Section title="Quick Import" icon="↓" category="library">
          <p className="font-mono text-[12px] text-muted mb-2">import directly from your detected integrations</p>
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

      </CategoryContext.Provider>
    </div>
  )
}

function Section(
  { title, icon, category, children }:
  { title: string; icon: string; category: SettingsCategory; children: React.ReactNode }
): JSX.Element | null {
  const active = useContext(CategoryContext)
  if (category !== active) return null
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 pb-1 border-b border-border/20">
        <span className="text-accent font-mono text-xs">{icon}</span>
        <h2 className="font-mono text-[13px] font-bold uppercase tracking-[0.15em] text-ink">{title}</h2>
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
      <label className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted block">{label}</label>
      <p className="font-mono text-[12px] text-muted/70">{description}</p>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={detected ? `detected: ${detected.split('/').pop()}` : 'not set'}
          className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/60"
        />
        <button onClick={handleChoose} className="px-2.5 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[12px] text-ink-soft hover:text-ink transition-colors shrink-0">
          browse
        </button>
        {detected && !value && (
          <button onClick={() => onChange(detected)} className="px-2.5 py-1.5 bg-accent/10 hover:bg-accent/20 border border-accent/25 rounded font-mono text-[12px] text-accent transition-colors shrink-0">
            use detected
          </button>
        )}
        {value && (
          <button onClick={() => window.api.settings.openInFinder(value)} className="px-2 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[12px] text-muted hover:text-ink transition-colors shrink-0" title="Reveal in Finder">
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
      <p className="font-mono text-[12px] text-muted/80 leading-relaxed">
        Use when a drive is renamed or your music folder moves. A single mapping fixes all affected track paths at once.
      </p>

      <div className="space-y-2">
        {(['from', 'to'] as const).map((which) => (
          <div key={which} className="flex items-center gap-1.5">
            <span className="font-mono text-[12px] text-muted uppercase tracking-[0.1em] w-7 shrink-0">
              {which === 'from' ? 'old' : 'new'}
            </span>
            <input
              type="text"
              value={which === 'from' ? from : to}
              onChange={(e) => { which === 'from' ? setFrom(e.target.value) : setTo(e.target.value); setPreview(null) }}
              placeholder={which === 'from' ? '/Volumes/OldDrive/Music' : '/Volumes/NewDrive/Music'}
              className="flex-1 bg-paper border border-border/40 rounded px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50"
            />
            <button
              onClick={() => handleBrowse(which)}
              className="px-2.5 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[12px] text-ink-soft hover:text-ink transition-colors shrink-0"
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
          className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[12px] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
        >
          preview
        </button>
        {preview !== null && (
          <button
            onClick={handleApply}
            disabled={applying || preview === 0}
            className="px-3 py-1.5 bg-accent hover:bg-accent/90 text-paper rounded font-mono text-[12px] transition-colors disabled:opacity-40"
          >
            {applying ? 'applying…' : `apply to ${preview} tracks`}
          </button>
        )}
        {preview === 0 && (
          <span className="font-mono text-[12px] text-muted">no tracks match that path prefix</span>
        )}
        {result !== null && (
          <span className="font-mono text-[12px] text-green-600 dark:text-green-400">
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

  if (!folders) return <span className="font-mono text-[12px] text-muted">loading…</span>

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted/80 leading-relaxed">
        Audio files added to a watched folder are automatically imported into the library. Supports .mp3, .flac, .aiff, .wav, .m4a, .ogg.
      </p>

      {folders.length === 0 ? (
        <p className="font-mono text-[12px] text-muted/50 italic">No watch folders configured.</p>
      ) : (
        <ul className="space-y-1.5">
          {folders.map((f) => (
            <li key={f} className="flex items-center gap-2 bg-ink/[0.03] border border-border/30 rounded px-3 py-2">
              <span className="flex-1 font-mono text-[13px] text-ink truncate">{f}</span>
              <button
                onClick={() => window.api.settings.openInFinder(f)}
                className="text-muted hover:text-ink transition-colors font-mono text-[12px]"
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
        className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[12px] text-ink-soft hover:text-ink transition-colors"
      >
        + add folder
      </button>
    </div>
  )
}

// ── PreListenSettings ─────────────────────────────────────────────────────────
// Lets the user pick a secondary audio output device for headphone cue monitoring

function PreListenSettings(): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedId, setSelectedId] = useState<string>(() =>
    localStorage.getItem('offcut-prelisten-device') ?? ''
  )
  const [permissionDenied, setPermissionDenied] = useState(false)

  // Enumerate audio output devices
  const loadDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== ''))
    } catch { setPermissionDenied(true) }
  }, [])

  useEffect(() => { loadDevices() }, [loadDevices])

  const selectDevice = (deviceId: string): void => {
    setSelectedId(deviceId)
    localStorage.setItem('offcut-prelisten-device', deviceId)
  }

  if (permissionDenied) {
    return (
      <p className="font-mono text-[12px] text-muted/70">
        Audio device access was denied. Grant permission in System Settings → Privacy → Microphone.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted/80 leading-relaxed">
        Select the audio output used for headphone pre-listen (CUE). Use the CUE button on each deck to route that deck to this output.
      </p>
      {devices.length === 0 ? (
        <p className="font-mono text-[12px] text-muted/50 italic">No additional audio outputs detected.</p>
      ) : (
        <div className="space-y-1.5">
          {/* Default system output */}
          <label className="flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors hover:border-border/60 border-border/30">
            <input
              type="radio" name="prelisten" value=""
              checked={selectedId === ''}
              onChange={() => selectDevice('')}
              className="accent-accent"
            />
            <span className="font-mono text-[13px] text-ink-soft">System default</span>
          </label>
          {devices.map((d) => (
            <label key={d.deviceId} className="flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors hover:border-border/60 border-border/30">
              <input
                type="radio" name="prelisten" value={d.deviceId}
                checked={selectedId === d.deviceId}
                onChange={() => selectDevice(d.deviceId)}
                className="accent-accent"
              />
              <span className="font-mono text-[13px] text-ink-soft truncate flex-1">
                {d.label || `Output ${d.deviceId.slice(0, 8)}`}
              </span>
            </label>
          ))}
        </div>
      )}
      <button
        onClick={loadDevices}
        className="font-mono text-[12px] text-muted hover:text-ink transition-colors uppercase tracking-[0.1em]"
      >
        refresh devices
      </button>
      <p className="font-mono text-[12px] text-muted/60">
        requires a second audio output device (e.g. USB audio interface, bluetooth headphones) · setSinkId routing applied at playback
      </p>
    </div>
  )
}

function QuickImportButton({ label, onClick }: { label: string; onClick: () => Promise<unknown> }): JSX.Element {
  const [loading, setLoading] = useState(false)
  return (
    <button
      onClick={async () => { setLoading(true); await onClick(); setLoading(false) }}
      disabled={loading}
      className="px-3 py-1.5 bg-ink/5 hover:bg-ink/10 border border-border/40 rounded font-mono text-[13px] text-ink-soft hover:text-ink transition-colors disabled:opacity-40"
    >
      {loading ? 'importing…' : `import from ${label}`}
    </button>
  )
}
