import { useEffect, useState } from 'react'
import { midiEngine } from './lib/midiEngine'
// Side-effect import: owns engine volumes (trim × fader × crossfader) at store
// level, so the mix keeps working when the Mixer component is unmounted.
import './lib/mixBus'
import { LibraryPage } from './pages/Library'
import { AnalysePage } from './pages/Analyse'
import { HealthPage } from './pages/Health'
import { OrganizePage } from './pages/Organize'
import { SmartFixesPage } from './pages/SmartFixes'
import { SettingsPage } from './pages/Settings'
import { SyncPage } from './pages/Sync'
import { SetBuilderPage } from './pages/SetBuilder'
import { OrdersPage } from './pages/Orders'
import { SearchPage } from './pages/Search'
import { LineagePage } from './pages/Lineage'
import { AssistantPage } from './pages/Assistant'
import { UsbPage } from './pages/Usb'
import { PhoneSyncPage } from './pages/PhoneSync'
import { SetHistoryPage } from './pages/SetHistory'
import { Sidebar } from './components/Sidebar'
import { NavRail } from './components/NavRail'
import type { Section } from './components/NavRail'
import { PageHelp } from './components/PageHelp'
import { Titlebar } from './components/Titlebar'
import { TrackDetail } from './components/TrackDetail'
import { Toast } from './components/Toast'
import { Onboarding } from './components/Onboarding'
import { LicenceGate } from './components/LicenceGate'
import { Player } from './components/Player'
import { LineageLibraryTray } from './components/LineageLibraryTray'
import { LibraryDock } from './components/LibraryDock'
import { FnBus } from './components/FnBus'
import { AnalysisProgressBar } from './components/AnalysisProgressBar'
import { TrackMenuProvider } from './hooks/useTrackMenu'
import { useLibraryStore } from './store/libraryStore'
import { useDeckAStore, useDeckBStore } from './store/playerStore'
import { ErrorBoundary } from './components/ErrorBoundary'

export default function App(): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const isLoading = useLibraryStore((s) => s.isLoading)
  const [activePage, setActivePage] = useState<Section>('library')
  // Keep-alive tabs: once a section has been visited it stays mounted (just
  // hidden when inactive), so its view/layout state survives leaving + returning.
  const [visited, setVisited] = useState<Set<Section>>(() => new Set<Section>([activePage]))
  useEffect(() => {
    setVisited((v) => (v.has(activePage) ? v : new Set(v).add(activePage)))
  }, [activePage])
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  // 'onboard' = first-run (welcome → tour → import); 'tour' = re-opened tour only.
  const [onboardMode, setOnboardMode] = useState<'onboard' | 'tour'>('onboard')
  const [showShortcuts, setShowShortcuts] = useState(false)
  // Licence gate: null = still checking, false = blocked, true = unlocked.
  const [licensed, setLicensed] = useState<boolean | null>(null)

  // MIDI engine — initialise once on mount
  useEffect(() => { midiEngine.init() }, [])

  // Native audio engine — activate both decks if the Rust addon is compiled & loaded.
  // Falls back silently to Web Audio if not yet available.
  useEffect(() => {
    window.api.engine.isAvailable().then((available) => {
      if (available) {
        useDeckAStore.getState().activateNativeEngine()
        useDeckBStore.getState().activateNativeEngine()
        console.info('[App] Native audio engine activated for decks A and B')
      } else {
        console.info('[App] Native engine not available — using Web Audio')
      }
    }).catch(() => {
      // IPC failure (e.g. engine handlers not registered yet) — stay on Web Audio
    })
  }, [])

  useEffect(() => { loadLibrary() }, [loadLibrary])

  // ⌘F / Ctrl+F → jump to Advanced Search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !(e.target as HTMLElement).matches('input, textarea')) {
        e.preventDefault()
        setActivePage('search')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const off = window.electron.ipcRenderer.on('library:watchFolderAdded', () => loadLibrary())
    return () => { off() }
  }, [loadLibrary])

  // Reload when a paired phone pushes prep edits.
  useEffect(() => window.api.sync.onLibraryChanged(() => loadLibrary()), [loadLibrary])

  useEffect(() => {
    if (isLoading) return
    window.api.settings.get().then((s) => {
      if (s.showWelcomeOnStartup) {
        setOnboardMode('onboard')
        setShowOnboarding(true)
      }
    })
  }, [isLoading])

  // Re-open the welcome tour on demand (Settings → "replay welcome tour", or a
  // help button). Shows the feature tour without re-running the import flow.
  useEffect(() => {
    const open = (): void => {
      setOnboardMode('tour')
      setShowOnboarding(true)
    }
    window.addEventListener('offcut:show-tour', open)
    return () => window.removeEventListener('offcut:show-tour', open)
  }, [])

  useEffect(() => {
    setDetailTrackId(selectedTrackIds.size === 1 ? [...selectedTrackIds][0] : null)
  }, [selectedTrackIds])

  // Hard licence gate — check activation once on launch (fail closed on error).
  useEffect(() => {
    window.api.licence
      .status()
      .then((s) => setLicensed(s.activated))
      .catch(() => setLicensed(false))
  }, [])

  // Block everything until a valid key is activated.
  if (licensed === null) return <div className="h-full bg-chassis" />
  if (!licensed) return <LicenceGate onActivated={() => setLicensed(true)} />

  return (
    <TrackMenuProvider>
    <div className="flex flex-col h-full bg-chassis relative">
      {/* Field-unit shell: bezel vignette + faint scanline over everything */}
      <div className="shell-overlay" aria-hidden="true" />
      <Titlebar />
      {activePage === 'library' && <FnBus />}

      <div className="flex flex-1 overflow-hidden relative">
        <NavRail active={activePage} onNavigate={setActivePage} />
        {activePage === 'library' && <ErrorBoundary name="sidebar" inline><Sidebar /></ErrorBoundary>}
        <main className="flex-1 overflow-hidden flex bg-chassis">
          <div className="flex-1 overflow-hidden">
            {(([
              ['library',    <ErrorBoundary name="library"><LibraryPage /></ErrorBoundary>],
              ['sync',       <ErrorBoundary name="sync"><SyncPage /></ErrorBoundary>],
              ['analyse',    <ErrorBoundary name="analyse"><AnalysePage /></ErrorBoundary>],
              ['health',     <ErrorBoundary name="health"><HealthPage /></ErrorBoundary>],
              ['organize',   <ErrorBoundary name="organize"><OrganizePage /></ErrorBoundary>],
              ['fixes',      <ErrorBoundary name="fixes"><SmartFixesPage /></ErrorBoundary>],
              ['builder',    <ErrorBoundary name="builder"><SetBuilderPage /></ErrorBoundary>],
              ['search',     <ErrorBoundary name="search"><SearchPage /></ErrorBoundary>],
              ['orders',     <ErrorBoundary name="orders"><OrdersPage /></ErrorBoundary>],
              ['lineage',    <ErrorBoundary name="lineage"><LineagePage /></ErrorBoundary>],
              ['assistant',  <ErrorBoundary name="assistant"><AssistantPage /></ErrorBoundary>],
              ['sethistory', <ErrorBoundary name="sethistory"><SetHistoryPage /></ErrorBoundary>],
              ['phonesync',  <ErrorBoundary name="phonesync"><PhoneSyncPage /></ErrorBoundary>],
              ['usb',        <ErrorBoundary name="usb"><UsbPage /></ErrorBoundary>],
              ['settings',   <ErrorBoundary name="settings"><SettingsPage /></ErrorBoundary>],
            ] as [Section, JSX.Element][])
              // Keep-alive: render a page once visited; hide (don't unmount) when inactive.
              .filter(([id]) => visited.has(id))
              .map(([id, node]) => (
                <div key={id} className="h-full" style={{ display: activePage === id ? 'contents' : 'none' }}>
                  {node}
                </div>
              )))}
          </div>
          {activePage === 'library' && detailTrackId && (
            <ErrorBoundary name="track-detail" inline>
              <TrackDetail trackId={detailTrackId} onClose={() => setDetailTrackId(null)} />
            </ErrorBoundary>
          )}
          {activePage === 'orders' && (
            <ErrorBoundary name="library-dock" inline>
              <LibraryDock />
            </ErrorBoundary>
          )}
        </main>
        <PageHelp page={activePage} />
      </div>

      {activePage === 'lineage' ? (
        <ErrorBoundary name="lineage-tray" inline><LineageLibraryTray /></ErrorBoundary>
      ) : (
        <ErrorBoundary name="player" inline><Player /></ErrorBoundary>
      )}

      {/* Colophon */}
      <div className="shrink-0 flex items-center justify-between px-4 border-t border-border/20 bg-chassis-soft"
           style={{ height: 16 }}>
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted/50">
          offcut · od·01 / firmware 1.0.4 · build 0028
        </span>
        <button
          onClick={() => setShowShortcuts(true)}
          className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted/30 hover:text-muted/70 transition-colors"
          title="Keyboard shortcuts"
        >
          ?
        </button>
      </div>

      <Toast />
      <AnalysisProgressBar />
      {showOnboarding && (
        <Onboarding
          mode={onboardMode}
          onComplete={() => {
            setShowOnboarding(false)
            // Don't auto-show again after a first-run pass (import or skip alike).
            if (onboardMode === 'onboard') void window.api.settings.save({ showWelcomeOnStartup: false })
          }}
        />
      )}
      {showShortcuts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowShortcuts(false)}>
          <div className="bg-chassis border border-border/40 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-mono text-[13px] font-bold uppercase tracking-[0.15em] text-ink">Keyboard Shortcuts</h2>
              <button onClick={() => setShowShortcuts(false)} className="text-muted hover:text-ink text-lg leading-none">×</button>
            </div>
            <div className="space-y-3 font-mono text-[12px]">
              {[
                ['Player', [
                  ['Space', 'Play / Pause Deck A'],
                  ['Alt+Space', 'Play / Pause Deck B'],
                  ['1–8', 'Jump to hot cue (Deck A)'],
                  ['Shift+1–8', 'Set hot cue (Deck A)'],
                  ['Alt+1–8', 'Jump to hot cue (Deck B)'],
                ]],
                ['Navigation', [
                  ['⌘F / Ctrl+F', 'Open Advanced Search'],
                ]],
                ['Library', [
                  ['Click', 'Select track'],
                  ['⌘+Click', 'Multi-select'],
                  ['Shift+Click', 'Range select'],
                  ['↑ / ↓', 'Move selection'],
                  ['Shift+↑/↓', 'Extend selection'],
                  ['⌘A', 'Select all'],
                  ['Space', 'Preview 30s'],
                  ['Enter', 'Load to Deck A'],
                  ['Shift+Enter', 'Load to Deck B'],
                  ['Delete', 'Remove from playlist'],
                  ['Esc', 'Clear selection'],
                ]],
              ].map(([section, shortcuts]) => (
                <div key={section as string}>
                  <p className="text-accent/70 uppercase tracking-[0.12em] text-[11px] mb-1.5">{section as string}</p>
                  <div className="space-y-1">
                    {(shortcuts as [string, string][]).map(([key, desc]) => (
                      <div key={key} className="flex items-baseline justify-between gap-4">
                        <code className="bg-ink/[0.07] border border-border/30 rounded px-1.5 py-0.5 text-ink-soft text-[11px] shrink-0">{key}</code>
                        <span className="text-muted/70 text-right">{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
    </TrackMenuProvider>
  )
}

