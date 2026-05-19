import { useEffect, useState } from 'react'
import { LibraryPage } from './pages/Library'
import { LibraryHealthPage } from './pages/LibraryHealth'
import { Sidebar } from './components/Sidebar'
import { Titlebar } from './components/Titlebar'
import { TrackDetail } from './components/TrackDetail'
import { Toast } from './components/Toast'
import { useLibraryStore } from './store/libraryStore'

type Page = 'library' | 'settings'

export default function App(): JSX.Element {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds)
  const [activePage, setActivePage] = useState<Page>('library')
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null)

  useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

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
            {activePage === 'settings' && <LibraryHealthPage />}
          </div>
          {activePage === 'library' && detailTrackId && (
            <TrackDetail
              trackId={detailTrackId}
              onClose={() => setDetailTrackId(null)}
            />
          )}
        </main>
      </div>
      <Toast />
    </div>
  )
}
