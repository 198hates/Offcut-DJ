import { useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import type { IntegrationId } from '@shared/types'

interface OnboardingProps {
  onComplete: () => void
}

interface DetectedApp {
  id: IntegrationId
  label: string
  icon: string
  path: string
  description: string
  isDirectory?: boolean
}

type Step = 'welcome' | 'detect' | 'import' | 'done'

export function Onboarding({ onComplete }: OnboardingProps): JSX.Element {
  const [step, setStep] = useState<Step>('welcome')
  const [detected, setDetected] = useState<DetectedApp[]>([])
  const [selected, setSelected] = useState<Set<IntegrationId>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<string[]>([])
  const { importFromIntegration } = useLibraryStore()
  const { show } = useToastStore()

  const runDetect = async (): Promise<void> => {
    const paths = await window.api.settings.getDetectedPaths()
    const found: DetectedApp[] = []

    if (paths.rekordboxDb) {
      found.push({
        id: 'rekordbox',
        label: 'Rekordbox',
        icon: '◈',
        path: paths.rekordboxDb,
        description: 'Direct database access — fastest import, full fidelity'
      })
    }
    if (paths.traktorCollection) {
      found.push({
        id: 'traktor',
        label: 'Traktor Pro',
        icon: '◉',
        path: paths.traktorCollection,
        description: 'Collection NML file — playlists, cue points, BPM, key'
      })
    }
    if (paths.seratoDir) {
      found.push({
        id: 'serato',
        label: 'Serato DJ',
        icon: '◎',
        path: paths.seratoDir,
        description: 'Serato crates and track metadata',
        isDirectory: true
      })
    }

    setDetected(found)
    setSelected(new Set(found.map((a) => a.id)))
    setStep('detect')
  }

  const runImport = async (): Promise<void> => {
    setImporting(true)
    setStep('import')
    const results: string[] = []

    for (const app of detected.filter((a) => selected.has(a.id))) {
      setImportProgress((prev) => [...prev, `Importing ${app.label}…`])
      const result = await importFromIntegration(app.id, app.path)
      results.push(`${app.label}: ${result.tracksImported} tracks`)
    }

    setImportProgress(results)
    setImporting(false)

    // Save paths to settings
    const paths = await window.api.settings.getDetectedPaths()
    await window.api.settings.save({
      rekordboxDbPath: paths.rekordboxDb || '',
      traktorCollectionPath: paths.traktorCollection || '',
      seratoDir: paths.seratoDir || '',
      showWelcomeOnStartup: false
    })

    show('Library imported successfully!', 'success')
    setStep('done')
  }

  return (
    <div className="fixed inset-0 z-50 bg-surface-950/95 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-surface-900 border border-white/10 rounded-2xl p-8 max-w-lg w-full shadow-2xl">
        {step === 'welcome' && (
          <WelcomeStep onGetStarted={runDetect} onSkip={onComplete} />
        )}
        {step === 'detect' && (
          <DetectStep
            detected={detected}
            selected={selected}
            onToggle={(id) => {
              const next = new Set(selected)
              next.has(id) ? next.delete(id) : next.add(id)
              setSelected(next)
            }}
            onImport={runImport}
            onSkip={onComplete}
          />
        )}
        {step === 'import' && (
          <ImportStep progress={importProgress} importing={importing} />
        )}
        {step === 'done' && (
          <DoneStep onFinish={onComplete} trackCount={useLibraryStore.getState().tracks.length} />
        )}
      </div>
    </div>
  )
}

function WelcomeStep({ onGetStarted, onSkip }: { onGetStarted: () => void; onSkip: () => void }): JSX.Element {
  return (
    <div className="text-center space-y-6">
      <div className="space-y-2">
        <div className="text-5xl mb-4">🎵</div>
        <h1 className="text-2xl font-bold text-white">Welcome to Crate</h1>
        <p className="text-white/50 text-sm leading-relaxed">
          Your central hub for managing music across Rekordbox, Serato, Traktor and Apple Music.
          Let's connect your existing DJ software.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-left">
        {[
          { icon: '↔', text: 'Sync between all DJ apps' },
          { icon: '✎', text: 'Edit metadata in bulk' },
          { icon: '⑂', text: 'Manage playlists centrally' },
          { icon: '⬡', text: 'Find duplicates & missing files' }
        ].map((f) => (
          <div key={f.text} className="flex items-center gap-2.5 bg-white/[0.03] rounded-lg px-3 py-2">
            <span className="text-accent text-sm">{f.icon}</span>
            <span className="text-xs text-white/70">{f.text}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={onGetStarted}
          className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium transition-colors"
        >
          Detect my DJ software →
        </button>
        <button onClick={onSkip} className="text-xs text-white/30 hover:text-white/60 transition-colors">
          Skip setup, I'll configure manually
        </button>
      </div>
    </div>
  )
}

function DetectStep({
  detected,
  selected,
  onToggle,
  onImport,
  onSkip
}: {
  detected: DetectedApp[]
  selected: Set<IntegrationId>
  onToggle: (id: IntegrationId) => void
  onImport: () => void
  onSkip: () => void
}): JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Found your DJ software</h2>
        <p className="text-sm text-white/40 mt-1">
          {detected.length > 0
            ? 'Select which libraries to import.'
            : 'No DJ software detected automatically.'}
        </p>
      </div>

      {detected.length > 0 ? (
        <div className="space-y-2">
          {detected.map((app) => (
            <label
              key={app.id}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                selected.has(app.id)
                  ? 'bg-accent/10 border-accent/30'
                  : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(app.id)}
                onChange={() => onToggle(app.id)}
                className="mt-0.5 accent-accent"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{app.icon}</span>
                  <span className="text-sm font-medium text-white">{app.label}</span>
                </div>
                <p className="text-xs text-white/40 mt-0.5">{app.description}</p>
                <p className="text-xs text-white/25 mt-0.5 truncate font-mono">{app.path}</p>
              </div>
            </label>
          ))}
        </div>
      ) : (
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 text-center">
          <p className="text-sm text-white/50">
            No DJ software found in default locations.
            You can add paths manually in Settings.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {detected.length > 0 && selected.size > 0 && (
          <button
            onClick={onImport}
            className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium transition-colors"
          >
            Import {selected.size} librar{selected.size !== 1 ? 'ies' : 'y'} →
          </button>
        )}
        <button onClick={onSkip} className="text-xs text-white/30 hover:text-white/60 transition-colors text-center">
          Skip, I'll import manually later
        </button>
      </div>
    </div>
  )
}

function ImportStep({ progress, importing }: { progress: string[]; importing: boolean }): JSX.Element {
  return (
    <div className="text-center space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Importing your library…</h2>
        <p className="text-sm text-white/40 mt-1">This may take a moment for large libraries.</p>
      </div>
      <div className="space-y-2 text-left">
        {progress.map((msg, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className={i === progress.length - 1 && importing ? 'animate-pulse text-accent' : 'text-green-400'}>
              {i === progress.length - 1 && importing ? '◌' : '✓'}
            </span>
            <span className="text-white/70">{msg}</span>
          </div>
        ))}
        {importing && (
          <div className="flex items-center gap-2 text-sm">
            <span className="animate-pulse text-accent">◌</span>
            <span className="text-white/40">Working…</span>
          </div>
        )}
      </div>
    </div>
  )
}

function DoneStep({ onFinish, trackCount }: { onFinish: () => void; trackCount: number }): JSX.Element {
  return (
    <div className="text-center space-y-6">
      <div className="space-y-2">
        <div className="text-5xl mb-4">✓</div>
        <h2 className="text-xl font-bold text-white">You're all set!</h2>
        <p className="text-white/50 text-sm">
          {trackCount.toLocaleString()} track{trackCount !== 1 ? 's' : ''} imported into your library.
          Start exploring, editing, and syncing.
        </p>
      </div>
      <button
        onClick={onFinish}
        className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium transition-colors"
      >
        Open my library →
      </button>
    </div>
  )
}
