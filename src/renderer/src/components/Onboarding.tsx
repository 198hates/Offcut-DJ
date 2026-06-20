import { useState, useEffect } from 'react'
import { useLibraryStore } from '../store/libraryStore'
import { useToastStore } from '../store/toastStore'
import type { IntegrationId } from '@shared/types'

interface OnboardingProps {
  onComplete: () => void
  /** 'onboard' = first run (welcome → tour → import); 'tour' = re-opened tour only. */
  mode?: 'onboard' | 'tour'
}

interface DetectedApp {
  id: IntegrationId; label: string; path: string
  description: string; isDirectory?: boolean
}

type Step = 'welcome' | 'tour' | 'rekordbox' | 'detect' | 'import' | 'done'

// Every workspace the nav rail exposes, with a one-line "what it does". Keep in
// step with NavRail's MAIN_ITEMS so the tour always reflects the real app.
const FEATURES: { icon: string; name: string; desc: string }[] = [
  { icon: '▤', name: 'Library', desc: 'Your whole collection in one place — search, sort, edit, drag to the decks.' },
  { icon: '↔', name: 'Sync', desc: 'Two-way sync with Rekordbox, Traktor, Serato, Engine DJ & Apple Music.' },
  { icon: '⚡', name: 'Analyse', desc: 'BPM, key, energy, LUFS loudness, audio-similarity & phrase detection.' },
  { icon: '◎', name: 'Library Health', desc: 'Find duplicates (incl. fingerprint), missing files, and take restorable backups.' },
  { icon: '✦', name: 'Smart Fixes', desc: 'Tidy messy metadata in bulk — AI-assisted where it helps.' },
  { icon: '▦', name: 'Set Builder', desc: 'Build sets with harmonic / energy suggestions and AI sequencing.' },
  { icon: '◷', name: 'Set History', desc: 'Log your sets, track residencies, debrief and compare nights.' },
  { icon: '⌕', name: 'Advanced Search', desc: 'Faceted + natural-language search across the whole library.' },
  { icon: '≣', name: 'Running Orders', desc: 'Plan running orders / chapters with auto-mix transition planning.' },
  { icon: '⑂', name: 'Lineage', desc: 'Crate-dig: follow credits, labels & related artists (Discogs · Deezer), plus AI dig.' },
  { icon: '✺', name: 'Assistant', desc: 'Chat to explore your library and assemble sets hands-free.' },
  { icon: '☎', name: 'Phone Sync', desc: 'Pair the companion mobile app over your local network.' },
  { icon: '⬓', name: 'USB Export', desc: 'Export CDJ-ready USB sticks — rekordbox waveforms, cues & database.' }
]

export function Onboarding({ onComplete, mode = 'onboard' }: OnboardingProps): JSX.Element {
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
    // Rekordbox has its own dedicated step; only the other apps appear here.
    if (paths.traktorCollection)  found.push({ id: 'traktor',   label: 'Traktor Pro', path: paths.traktorCollection,  description: 'collection.nml · playlists, cues, bpm, key' })
    if (paths.seratoDir)          found.push({ id: 'serato',    label: 'Serato DJ',   path: paths.seratoDir,          description: 'crates and track metadata', isDirectory: true })
    setDetected(found)
    setSelected(new Set(found.map((a) => a.id)))
    setStep('detect')
  }

  // From the tour: first run continues into the Rekordbox link step; a re-opened
  // tour just closes.
  const afterTour = (): void => {
    if (mode === 'onboard') setStep('rekordbox')
    else onComplete()
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
        <div className="mb-6 pb-4 border-b border-border/30 flex items-center justify-between">
          <p className="font-mono text-[12px] uppercase tracking-[0.22em] text-muted">
            <span className="text-accent font-bold mr-1.5">offcut</span>od·01 · {mode === 'tour' ? 'tour' : 'setup'}
          </p>
          {mode === 'tour' && (
            <button onClick={onComplete} className="font-mono text-[12px] text-muted hover:text-ink transition-colors">
              close ✕
            </button>
          )}
        </div>

        {step === 'welcome' && <WelcomeStep mode={mode} onGetStarted={() => setStep('tour')} onSkip={onComplete} />}
        {step === 'tour'    && <TourStep mode={mode} onBack={() => setStep('welcome')} onContinue={afterTour} />}
        {step === 'rekordbox' && <RekordboxStep onContinue={() => void runDetect()} />}
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

function WelcomeStep({ mode, onGetStarted, onSkip }: { mode: 'onboard' | 'tour'; onGetStarted: () => void; onSkip: () => void }): JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-sans font-bold text-xl text-ink mb-1">welcome to offcut</h1>
        <p className="font-mono text-[13px] text-muted leading-relaxed">
          One home for your whole DJ library — sync it across every app, analyse and fix it, dig for
          new music, build and log your sets. Here&apos;s the quick tour.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={onGetStarted}
          className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors"
        >
          take the tour →
        </button>
        <button onClick={onSkip} className="font-mono text-[12px] text-muted hover:text-ink transition-colors text-center">
          {mode === 'tour' ? 'close' : 'skip · configure manually in settings'}
        </button>
      </div>
    </div>
  )
}

function TourStep({ mode, onBack, onContinue }: { mode: 'onboard' | 'tour'; onBack: () => void; onContinue: () => void }): JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-sans font-bold text-lg text-ink mb-1">what&apos;s inside</h2>
        <p className="font-mono text-[13px] text-muted">every workspace lives on the left rail — here&apos;s what each does</p>
      </div>

      <div className="space-y-1.5 max-h-[46vh] overflow-y-auto pr-1 -mr-1">
        {FEATURES.map((f) => (
          <div key={f.name} className="flex items-start gap-3 bg-ink/[0.03] border border-border/30 rounded px-3 py-2">
            <span className="text-accent font-mono text-sm shrink-0 w-4 text-center leading-5">{f.icon}</span>
            <div className="min-w-0">
              <p className="font-mono text-[12.5px] font-bold text-ink leading-tight">{f.name}</p>
              <p className="font-mono text-[11.5px] text-muted leading-snug mt-0.5">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={onBack} className="font-mono text-[12px] text-muted hover:text-ink transition-colors px-2">
          ← back
        </button>
        <button
          onClick={onContinue}
          className="flex-1 py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors"
        >
          {mode === 'onboard' ? 'next · connect your library →' : 'done'}
        </button>
      </div>
    </div>
  )
}

function RekordboxStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  const { importFromIntegration } = useLibraryStore()
  const { show } = useToastStore()
  const [path, setPath] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    window.api.settings.getDetectedPaths().then((p) => {
      setPath(p.rekordboxDb || null)
      setChecking(false)
    })
  }, [])

  const browse = async (): Promise<void> => {
    const p = await window.api.settings.choosePath('Locate Rekordbox master.db', false)
    if (p) setPath(p)
  }

  const link = async (): Promise<void> => {
    if (!path) return
    setImporting(true)
    await window.api.settings.save({ rekordboxDbPath: path })
    const res = await importFromIntegration('rekordbox', path)
    setImporting(false)
    show(`Rekordbox linked — ${res.tracksImported} tracks`, 'success')
    onContinue()
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-sans font-bold text-lg text-ink mb-1">connect Rekordbox</h2>
        <p className="font-mono text-[13px] text-muted leading-relaxed">
          Offcut links straight to your Rekordbox database — your full library, playlists, cues and
          grids, kept in sync both ways. No XML export needed.
        </p>
      </div>

      {checking ? (
        <div className="font-mono text-[13px] text-muted">looking for Rekordbox…</div>
      ) : path ? (
        <div className="bg-accent/[0.07] border border-accent/30 rounded p-3">
          <p className="font-mono text-[12px] font-bold text-ink">✓ Rekordbox database found</p>
          <p className="font-mono text-[11px] text-muted mt-1 break-all">{path}</p>
          <button onClick={browse} className="font-mono text-[11px] text-accent hover:underline mt-1.5">
            choose a different file
          </button>
        </div>
      ) : (
        <div className="bg-ink/[0.03] border border-border/30 rounded p-3 space-y-2">
          <p className="font-mono text-[12px] text-ink">Couldn&apos;t find it automatically.</p>
          <p className="font-mono text-[11px] text-muted leading-relaxed">
            It usually lives at{' '}
            <span className="text-ink-soft">~/Library/Pioneer/rekordbox/master.db</span>. Locate it
            manually, or set it up later in Settings → Rekordbox (you can point at a collection XML
            there instead).
          </p>
          <button
            onClick={browse}
            className="px-3 py-1.5 rounded font-mono text-[12px] uppercase tracking-[0.1em] border border-border/40 text-ink hover:bg-ink/[0.05] transition-colors"
          >
            locate master.db…
          </button>
        </div>
      )}

      <div className="flex items-start gap-2 font-mono text-[11px] text-muted bg-ink/[0.03] border border-border/30 rounded p-2.5">
        <span className="shrink-0 text-accent">ℹ</span>
        <span>
          Quit Rekordbox before Offcut writes back to it — the two apps can&apos;t hold the database
          at the same time.
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {path && (
          <button
            onClick={link}
            disabled={importing}
            className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors disabled:opacity-50"
          >
            {importing ? 'linking & importing…' : 'link rekordbox →'}
          </button>
        )}
        <button
          onClick={onContinue}
          disabled={importing}
          className="font-mono text-[12px] text-muted hover:text-ink transition-colors text-center"
        >
          skip · set up later in settings
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
        <p className="font-mono text-[13px] text-muted">
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
                <p className="font-mono text-[13px] font-bold text-ink">{app.label}</p>
                <p className="font-mono text-[12px] text-muted mt-0.5">{app.description}</p>
                <p className="font-mono text-[12px] text-muted/60 mt-0.5 truncate">{app.path.split('/').slice(-3).join('/')}</p>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {detected.length > 0 && selected.size > 0 && (
          <button onClick={onImport} className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors">
            import {selected.size} librar{selected.size !== 1 ? 'ies' : 'y'} →
          </button>
        )}
        <button onClick={onSkip} className="font-mono text-[12px] text-muted hover:text-ink transition-colors text-center">
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
        <p className="font-mono text-[13px] text-muted">may take a moment for large libraries</p>
      </div>
      <div className="space-y-2">
        {progress.map((msg, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${i === progress.length - 1 && importing ? 'bg-accent animate-pulse' : 'bg-green-500'}`} />
            <span className="font-mono text-[13px] text-ink-soft">{msg}</span>
          </div>
        ))}
        {importing && (
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent animate-pulse" />
            <span className="font-mono text-[13px] text-muted">working…</span>
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
        <p className="font-mono text-[13px] text-muted">
          {trackCount.toLocaleString()} track{trackCount !== 1 ? 's' : ''} imported
        </p>
      </div>
      <button onClick={onFinish} className="w-full py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors">
        open library →
      </button>
    </div>
  )
}
