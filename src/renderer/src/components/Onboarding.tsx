import { useState } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import type { IntegrationId } from '@shared/types'

interface OnboardingProps { onComplete: () => void }

interface DetectedApp {
  id: IntegrationId; label: string; path: string
  description: string; isDirectory?: boolean
}

type Step = 'welcome' | 'detect' | 'import' | 'done'

export function Onboarding({ onComplete }: OnboardingProps): JSX.Element {
  const [step, setStep]           = useState<Step>('welcome')
  const [detected, setDetected]   = useState<DetectedApp[]>([])
  const [selected, setSelected]   = useState<Set<IntegrationId>>(new Set())
  const [importing, setImporting] = useState(false)
  const [progress, setProgress]   = useState<string[]>([])
  const { importFromIntegration } = useLibraryStore()
  const { show } = useToastStore()

  const runDetect = async (): Promise<void> => {
    const paths = await window.api.settings.getDetectedPaths()
    const found: DetectedApp[] = []
    if (paths.rekordboxDb)        found.push({ id: 'rekordbox', label: 'Rekordbox',  path: paths.rekordboxDb,        description: 'direct db access · full fidelity · fastest' })
    if (paths.traktorCollection)  found.push({ id: 'traktor',   label: 'Traktor Pro', path: paths.traktorCollection,  description: 'collection.nml · playlists, cues, bpm, key' })
    if (paths.seratoDir)          found.push({ id: 'serato',    label: 'Serato DJ',   path: paths.seratoDir,          description: 'crates and track metadata', isDirectory: true })
    setDetected(found)
    setSelected(new Set(found.map((a) => a.id)))
    setStep('detect')
  }

  const runImport = async (): Promise<void> => {
    setImporting(true); setStep('import')
    for (const app of detected.filter((a) => selected.has(a.id))) {
      setProgress((p) => [...p, `importing ${app.label}…`])
      const result = await importFromIntegration(app.id, app.path)
      setProgress((p) => [...p.slice(0, -1), `${app.label}: ${result.tracksImported} tracks`])
    }
    setImporting(false)
    const paths = await window.api.settings.getDetectedPaths()
    await window.api.settings.save({
      rekordboxDbPath: paths.rekordboxDb || '',
      traktorCollectionPath: paths.traktorCollection || '',
      seratoDir: paths.seratoDir || '',
      showWelcomeOnStartup: false
    })
    show('library imported', 'success')
    setStep('done')
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/50 flex items-center justify-center p-8">
      <div
        className="bg-chassis border border-border/50 rounded-lg p-8 max-w-lg w-full"
        style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.12)' }}
      >
        {/* Panel header */}
        <div className="mb-6 pb-4 border-b border-border/30">
          <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted">
            <span className="text-accent font-bold mr-1.5">cr·8</span>od-1 · setup
          </p>
        </div>

        {step === 'welcome' && <WelcomeStep onGetStarted={runDetect} onSkip={onComplete} />}
        {step === 'detect'  && (
          <DetectStep
            detected={detected} selected={selected}
            onToggle={(id) => {
              const next = new Set(selected)
              next.has(id) ? next.delete(id) : next.add(id)
              setSelected(next)
            }}
            onImport={runImport} onSkip={onComplete}
          />
        )}
        {step === 'import' && <ImportStep progress={progress} importing={importing} />}
        {step === 'done'   && <DoneStep onFinish={onComplete} trackCount={useLibraryStore.getState().tracks.length} />}
      </div>
    </div>
  )
}

function WelcomeStep({ onGetStarted, onSkip }: { onGetStarted: () => void; onSkip: () => void }): JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-sans font-bold text-xl text-ink mb-1">welcome to crate</h1>
        <p className="font-mono text-[10px] text-muted leading-relaxed">
          connect your existing dj software and manage everything in one place.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { icon: '↔', text: 'sync between all dj apps' },
          { icon: '✎', text: 'edit metadata in bulk' },
          { icon: '⑂', text: 'manage playlists centrally' },
          { icon: '◎', text: 'find duplicates + missing files' }
        ].map((f) => (
          <div key={f.text} className="flex items-center gap-2.5 bg-ink/[0.03] border border-border/30 rounded px-3 py-2">
            <span className="text-accent font-mono text-xs shrink-0">{f.icon}</span>
            <span className="font-mono text-[9.5px] text-ink-soft">{f.text}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={onGetStarted}
          className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[10px] uppercase tracking-[0.14em] rounded transition-colors"
        >
          detect my dj software →
        </button>
        <button onClick={onSkip} className="font-mono text-[9.5px] text-muted hover:text-ink transition-colors text-center">
          skip · configure manually in settings
        </button>
      </div>
    </div>
  )
}

function DetectStep({
  detected, selected, onToggle, onImport, onSkip
}: {
  detected: DetectedApp[]; selected: Set<IntegrationId>
  onToggle: (id: IntegrationId) => void; onImport: () => void; onSkip: () => void
}): JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-sans font-bold text-lg text-ink mb-1">
          {detected.length > 0 ? 'dj software detected' : 'no software detected'}
        </h2>
        <p className="font-mono text-[10px] text-muted">
          {detected.length > 0
            ? 'select which libraries to import'
            : 'no dj software found at default paths · add them manually in settings'}
        </p>
      </div>

      {detected.length > 0 && (
        <div className="space-y-1.5">
          {detected.map((app) => (
            <label
              key={app.id}
              className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                selected.has(app.id)
                  ? 'bg-accent/[0.07] border-accent/30'
                  : 'bg-ink/[0.03] border-border/30 hover:bg-ink/[0.05]'
              }`}
            >
              <input type="checkbox" checked={selected.has(app.id)} onChange={() => onToggle(app.id)} className="mt-0.5 accent-accent" />
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[10.5px] font-bold text-ink">{app.label}</p>
                <p className="font-mono text-[9.5px] text-muted mt-0.5">{app.description}</p>
                <p className="font-mono text-[9px] text-muted/60 mt-0.5 truncate">{app.path.split('/').slice(-3).join('/')}</p>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {detected.length > 0 && selected.size > 0 && (
          <button onClick={onImport} className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[10px] uppercase tracking-[0.14em] rounded transition-colors">
            import {selected.size} librar{selected.size !== 1 ? 'ies' : 'y'} →
          </button>
        )}
        <button onClick={onSkip} className="font-mono text-[9.5px] text-muted hover:text-ink transition-colors text-center">
          skip · import manually later
        </button>
      </div>
    </div>
  )
}

function ImportStep({ progress, importing }: { progress: string[]; importing: boolean }): JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-sans font-bold text-lg text-ink mb-1">importing library</h2>
        <p className="font-mono text-[10px] text-muted">may take a moment for large libraries</p>
      </div>
      <div className="space-y-2">
        {progress.map((msg, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${i === progress.length - 1 && importing ? 'bg-accent animate-pulse' : 'bg-green-500'}`} />
            <span className="font-mono text-[10px] text-ink-soft">{msg}</span>
          </div>
        ))}
        {importing && (
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent animate-pulse" />
            <span className="font-mono text-[10px] text-muted">working…</span>
          </div>
        )}
      </div>
    </div>
  )
}

function DoneStep({ onFinish, trackCount }: { onFinish: () => void; trackCount: number }): JSX.Element {
  return (
    <div className="space-y-6 text-center">
      <div>
        <div className="inline-block w-8 h-8 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center mb-4">
          <span className="text-green-600 dark:text-green-400 font-mono text-sm font-bold">✓</span>
        </div>
        <h2 className="font-sans font-bold text-lg text-ink mb-1">library ready</h2>
        <p className="font-mono text-[10px] text-muted">
          {trackCount.toLocaleString()} track{trackCount !== 1 ? 's' : ''} imported
        </p>
      </div>
      <button onClick={onFinish} className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[10px] uppercase tracking-[0.14em] rounded transition-colors">
        open library →
      </button>
    </div>
  )
}
