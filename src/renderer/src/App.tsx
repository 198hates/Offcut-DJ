import { useEffect, useState } from 'react'
import { LibraryPage } from './pages/Library'
import { LibraryHealthPage } from './pages/LibraryHealth'
import { SettingsPage } from './pages/Settings'
import { SyncPage } from './pages/Sync'
import { SetBuilderPage } from './pages/SetBuilder'
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

const REG_MARKS: { pos: string; cls: string }[] = [
  { pos: 'top-[10px] left-[10px]',    cls: 'reg-mark-tl' },
  { pos: 'top-[10px] right-[10px]',   cls: 'reg-mark-tr' },
  { pos: 'bottom-[10px] left-[10px]', cls: 'reg-mark-bl' },
  { pos: 'bottom-[10px] right-[10px]',cls: 'reg-mark-br' },
]

export default function App(): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const tracks = useLibraryStore((s) => s.tracks)
  const isLoading = useLibraryStore((s) => s.isLoading)
  const [activePage, setActivePage] = useState<Section>('library')
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => { loadLibrary() }, [loadLibrary])

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
      {/* Corner register marks */}
      {REG_MARKS.map(({ pos, cls }) => (
        <div key={cls} className={`absolute ${pos} reg-mark ${cls}`} />
      ))}

      <Titlebar />
      <FnBus />

      <div className="flex flex-1 overflow-hidden">
        <NavRail active={activePage} onNavigate={setActivePage} />
        {activePage === 'library' && <Sidebar />}
        <main className="flex-1 overflow-hidden flex bg-chassis">
          <div className="flex-1 overflow-hidden">
            {activePage === 'library'  && <LibraryPage />}
            {activePage === 'sync'     && <SyncPage />}
            {activePage === 'analysis' && <LibraryHealthPage />}
            {activePage === 'builder'  && <SetBuilderPage />}
            {activePage === 'settings' && <SettingsPage />}
          </div>
          {activePage === 'library' && detailTrackId && (
            <TrackDetail trackId={detailTrackId} onClose={() => setDetailTrackId(null)} />
          )}
        </main>
      </div>

      <Player />

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
        <span className="font-mono text-[7.5px] tracking-[0.18em] uppercase text-muted/50">
          sn 2026·0001 / field unit · not for resale
        </span>
      </div>

      <Toast />
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}
    </div>
  )
}
