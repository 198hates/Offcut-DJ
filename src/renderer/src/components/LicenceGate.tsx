import { useState } from 'react'

/**
 * Full-screen licence gate. Rendered by App in place of the whole UI until a
 * valid key is activated — there is no skip and no close. Once a key validates
 * the parent unlocks the app.
 */
export function LicenceGate({ onActivated }: { onActivated: () => void }): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activate = async (): Promise<void> => {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const { ok } = await window.api.licence.activate(key)
      if (ok) {
        onActivated()
        return
      }
      setError('That key isn’t valid. Check it and try again.')
    } catch {
      setError('Couldn’t verify the key — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-chassis flex items-center justify-center p-8 select-none">
      <div
        className="bg-chassis-soft border border-border/50 rounded-lg p-8 max-w-md w-full"
        style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.25), 0 4px 16px rgba(0,0,0,0.14)' }}
      >
        <div className="mb-6 pb-4 border-b border-border/30">
          <p className="font-mono text-[12px] uppercase tracking-[0.22em] text-muted">
            <span className="text-accent font-bold mr-1.5">cr·8</span>od-1 · activation
          </p>
        </div>

        <h1 className="font-sans font-bold text-xl text-ink mb-1">activate offcut</h1>
        <p className="font-mono text-[13px] text-muted leading-relaxed mb-5">
          Enter your licence key to unlock the app. Don&apos;t have one? Contact{' '}
          <span className="text-ink-soft">Between the Bridges</span> for a key.
        </p>

        <input
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void activate()
          }}
          placeholder="OFFCUT-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          className="w-full bg-paper border border-border/40 rounded px-3 py-2.5 font-mono text-[14px] uppercase tracking-[0.1em] text-ink outline-none focus:border-accent transition-colors placeholder-muted/50"
        />

        {error && <p className="font-mono text-[12px] text-accent mt-2">{error}</p>}

        <button
          onClick={() => void activate()}
          disabled={busy || !key.trim()}
          className="w-full mt-4 py-2.5 bg-accent hover:bg-accent/90 text-paper font-mono text-[13px] uppercase tracking-[0.14em] rounded transition-colors disabled:opacity-40"
        >
          {busy ? 'verifying…' : 'activate →'}
        </button>

        <p className="font-mono text-[11px] text-muted/60 leading-relaxed mt-5 pt-4 border-t border-border/20">
          Offcut © 2026 Between the Bridges / Peppermint Events Limited. Licensed for personal use —
          not for resale or redistribution.
        </p>
      </div>
    </div>
  )
}
