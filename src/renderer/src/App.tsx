import { useEffect, useState } from 'react'
import { LibraryPage } from './pages/Library'
import { AnalysePage } from './pages/Analyse'
import { HealthPage } from './pages/Health'
import { SmartFixesPage } from './pages/SmartFixes'
import { SettingsPage } from './pages/Settings'
import { SyncPage } from './pages/Sync'
import { SetBuilderPage } from './pages/SetBuilder'
import { CompassPage } from './pages/Compass'
import { OrdersPage } from './pages/Orders'
import { SearchPage } from './pages/Search'
import { Sidebar } from './components/Sidebar'
import { NavRail } from './components/NavRail'
import type { Section } from './components/NavRail'
import { Titlebar } from './components/Titlebar'
import { TrackDetail } from './components/TrackDetail'
import { Toast } from './components/Toast'
import { Onboarding } from './components/Onboarding'
import { Player } from './components/Player'
import { FnBus } from './components/FnBus'
import { useLibraryStore } from './store/libraryStore'
import { ErrorBoundary } from './components/ErrorBoundary'

export default function App(): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const tracks = useLibraryStore((s) => s.tracks)
  const isLoading = useLibraryStore((s) => s.isLoading)
  const [activePage, setActivePage] = useState<Section>('library')
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

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

  useEffect(() => {
    if (isLoading) return
    window.api.settings.get().then((s) => {
      if (tracks.length === 0 && s.showWelcomeOnStartup) setShowOnboarding(true)
    })
  }, [isLoading, tracks.length])

  useEffect(() => {
    setDetailTrackId(selectedTrackIds.size === 1 ? [...selectedTrackIds][0] : null)
  }, [selectedTrackIds])

  return (
    <div className="flex flex-col h-full bg-chassis relative">
      <Titlebar />
      {activePage === 'library' && <FnBus />}

      <div className="flex flex-1 overflow-hidden">
        <NavRail active={activePage} onNavigate={setActivePage} />
        {activePage === 'library' && <ErrorBoundary name="sidebar" inline><Sidebar /></ErrorBoundary>}
        <main className="flex-1 overflow-hidden flex bg-chassis">
          <div className="flex-1 overflow-hidden">
            {activePage === 'library' && <ErrorBoundary name="library"><LibraryPage /></ErrorBoundary>}
            {activePage === 'sync'    && <ErrorBoundary name="sync"><SyncPage /></ErrorBoundary>}
            {activePage === 'analyse' && <ErrorBoundary name="analyse"><AnalysePage /></ErrorBoundary>}
            {activePage === 'health'  && <ErrorBoundary name="health"><HealthPage /></ErrorBoundary>}
            {activePage === 'fixes'   && <ErrorBoundary name="fixes"><SmartFixesPage /></ErrorBoundary>}
            {activePage === 'builder' && <ErrorBoundary name="builder"><SetBuilderPage /></ErrorBoundary>}
            {activePage === 'search'  && <ErrorBoundary name="search"><SearchPage /></ErrorBoundary>}
            {activePage === 'orders'  && <ErrorBoundary name="orders"><OrdersPage /></ErrorBoundary>}
            {activePage === 'compass' && <ErrorBoundary name="compass"><CompassPage /></ErrorBoundary>}
            {activePage === 'settings'&& <ErrorBoundary name="settings"><SettingsPage /></ErrorBoundary>}
          </div>
          {activePage === 'library' && detailTrackId && (
            <ErrorBoundary name="track-detail" inline>
              <TrackDetail trackId={detailTrackId} onClose={() => setDetailTrackId(null)} />
            </ErrorBoundary>
          )}
        </main>
      </div>

      <ErrorBoundary name="player" inline><Player /></ErrorBoundary>

      {/* Colophon */}
      <div className="shrink-0 flex items-center justify-between px-4 border-t border-border/20 bg-chassis-soft"
           style={{ height: 16 }}>
        <span className="font-mono text-[7.5px] tracking-[0.18em] uppercase text-muted/50">
          offcut · od·01 / firmware 1.0.0 · build 0001
        </span>
        <span className="text-muted/40" style={{
          fontFamily: "'Fraunces', serif",
          fontStyle: 'italic',
          fontWeight: 400,
          fontSize: 8,
          letterSpacing: '0.01em',
        }}>
          Set in Fraunces &amp; IBM Plex Mono. Made for the long mix.
        </span>
        <button
          onClick={() => setShowShortcuts(true)}
          className="font-mono text-[7.5px] tracking-[0.18em] uppercase text-muted/30 hover:text-muted/70 transition-colors"
          title="Keyboard shortcuts"
        >
          sn 2026·0001 / field unit · not for resale · ?
        </button>
      </div>

      <Toast />
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}
      {showShortcuts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowShortcuts(false)}>
          <div className="bg-chassis border border-border/40 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-ink">Keyboard Shortcuts</h2>
              <button onClick={() => setShowShortcuts(false)} className="text-muted hover:text-ink text-lg leading-none">×</button>
            </div>
            <div className="space-y-3 font-mono text-[9.5px]">
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
                  <p className="text-accent/70 uppercase tracking-[0.12em] text-[8px] mb-1.5">{section as string}</p>
                  <div className="space-y-1">
                    {(shortcuts as [string, string][]).map(([key, desc]) => (
                      <div key={key} className="flex items-baseline justify-between gap-4">
                        <code className="bg-ink/[0.07] border border-border/30 rounded px-1.5 py-0.5 text-ink-soft text-[8.5px] shrink-0">{key}</code>
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
  )
}
