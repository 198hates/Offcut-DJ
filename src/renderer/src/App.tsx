import { useEffect, useState } from 'react'
import { LibraryPage } from './pages/Library'
import { LibraryHealthPage } from './pages/LibraryHealth'
import { SettingsPage } from './pages/Settings'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { TrackDetail } from './components/TrackDetail'
import { Toast } from './components/Toast'
import { Onboarding } from './components/Onboarding'
import { Player } from './components/Player'
import { useLibraryStore } from './store/libraryStore'

type Page = 'library' | 'health' | 'settings'

export default function App(): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const tracks = useLibraryStore((s) => s.tracks)
  const isLoading = useLibraryStore((s) => s.isLoading)
  const [activePage, setActivePage] = useState<Page>('library')
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  // Show onboarding when library is empty and settings say to show it
  useEffect(() => {
    if (isLoading) return
    window.api.settings.get().then((s) => {
      if (tracks.length === 0 && s.showWelcomeOnStartup) {
        setShowOnboarding(true)
      }
    })
  }, [isLoading, tracks.length])

  useEffect(() => {
    if (selectedTrackIds.size === 1) {
      setDetailTrackId([...selectedTrackIds][0])
    } else {
      setDetailTrackId(null)
    }
  }, [selectedTrackIds])

  return (
    <div className="flex flex-col h-full bg-surface-950">
      <Titlebar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activePage={activePage} onNavigate={setActivePage} />
        <main className="flex-1 overflow-hidden flex">
          <div className="flex-1 overflow-hidden">
            {activePage === 'library' && <LibraryPage />}
            {activePage === 'health' && <LibraryHealthPage />}
            {activePage === 'settings' && <SettingsPage />}
          </div>
          {activePage === 'library' && detailTrackId && (
            <TrackDetail
              trackId={detailTrackId}
              onClose={() => setDetailTrackId(null)}
            />
          )}
        </main>
      </div>
      <Player />
      <Toast />
      {showOnboarding && (
        <Onboarding onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
  )
}
