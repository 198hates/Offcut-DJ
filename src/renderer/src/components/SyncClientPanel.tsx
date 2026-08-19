/**
 * SyncClientPanel — mirror ANOTHER desktop's library onto this machine.
 *
 * The counterpart to PhoneSyncPanel: that one serves this library to a phone,
 * this one consumes someone else's. Intended for a second machine that holds
 * none of the audio — a pull of a 15k-track library is ~19.5MB because the host
 * strips grids and embeddings — so you can manage playlists and metadata away
 * from the machine the files live on, and push the edits back.
 */
import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '../store/toastStore'
import { useLibraryStore } from '../store/libraryStore'

interface ClientStatus {
  host: string
  port: number
  enabled: boolean
  hasToken: boolean
  remoteCursor: number
  pushCursor: number
  lastPullAt: string | null
  lastPushAt: string | null
  lastError: string | null
}

const when = (iso: string | null): string => {
  if (!iso) return 'never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString()
}

export function SyncClientPanel(): JSX.Element {
  const [status, setStatus] = useState<ClientStatus | null>(null)
  const [pairUri, setPairUri] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('47823')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [reachable, setReachable] = useState<string | null>(null)
  const show = useToastStore((s) => s.show)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)

  const refresh = useCallback(async () => {
    const s = (await window.api.syncClient.status()) as unknown as ClientStatus
    setStatus(s)
    if (s.host) setHost(s.host)
    if (s.port) setPort(String(s.port))
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const probe = async (): Promise<void> => {
    setBusy('probe')
    const r = await window.api.syncClient.probe()
    setReachable(r.ok ? `${r.name ?? 'Offcut'} ${r.version ?? ''}`.trim() : `unreachable — ${r.error}`)
    setBusy(null)
  }

  const pair = async (): Promise<void> => {
    setBusy('pair')
    const r = await window.api.syncClient.pairFromUri(pairUri)
    setBusy(null)
    if (!r.ok) return show(`Pairing failed: ${r.error}`, 'error')
    setPairUri('')
    await refresh()
    show('Paired with host', 'success')
  }

  const saveManual = async (): Promise<void> => {
    if (!host.trim()) return show('Enter the host address', 'error')
    setBusy('save')
    await window.api.syncClient.configure({
      host: host.trim(), port: Number(port) || 47823, token: token.trim() || undefined, enabled: true
    })
    setToken('') // don't keep it in component state once it's stored
    setBusy(null)
    await refresh()
    show('Host saved', 'success')
  }

  const syncNow = async (): Promise<void> => {
    setBusy('sync')
    const r = await window.api.syncClient.syncNow()
    setBusy(null)
    if (!r.ok) { show(`Sync failed: ${r.error}`, 'error'); await refresh(); return }
    const pulled = r.pulled ?? {}
    const pushed = r.pushed ?? {}
    show(
      `Synced — sent ${pushed.playlists ?? 0} playlist edit(s), received ${pulled.tracks ?? 0} track(s)`,
      'success'
    )
    await refresh()
    // The pull wrote straight to the database, so the in-memory library is stale.
    await loadLibrary()
  }

  const reset = async (): Promise<void> => {
    setBusy('reset')
    await window.api.syncClient.reset()
    setBusy(null)
    setReachable(null)
    await refresh()
    show('Host forgotten', 'info')
  }

  if (!status) return <div className="font-mono text-[12px] text-muted/60">Loading…</div>

  const connected = status.host !== '' && status.hasToken

  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] text-muted/60 leading-relaxed">
        Mirror another machine&rsquo;s Offcut library onto this one. No audio is
        transferred — only the library — so this machine can manage playlists and
        metadata without holding the files. Edits made here sync back.
      </p>

      {connected ? (
        <div className="space-y-3">
          <div className="font-mono text-[12px] text-ink-soft">
            host <span className="text-accent">{status.host}:{status.port}</span>
            {reachable && <span className="text-muted/60 ml-2">· {reachable}</span>}
          </div>
          <div className="font-mono text-[11px] text-muted/60 space-y-0.5">
            <div>last received: {when(status.lastPullAt)}</div>
            <div>last sent: {when(status.lastPushAt)}</div>
            {status.lastError && (
              <div className="text-red-400/80">last error: {status.lastError}</div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={syncNow} disabled={busy !== null}
              className="font-mono text-[12px] px-3 py-1.5 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors">
              {busy === 'sync' ? 'syncing…' : 'sync now'}
            </button>
            <button onClick={probe} disabled={busy !== null}
              className="font-mono text-[12px] px-3 py-1.5 rounded border border-border/40 text-ink-soft hover:bg-ink/5 disabled:opacity-40 transition-colors">
              {busy === 'probe' ? 'checking…' : 'test connection'}
            </button>
            <button onClick={reset} disabled={busy !== null}
              className="font-mono text-[12px] px-3 py-1.5 rounded border border-border/40 text-muted hover:text-ink hover:bg-ink/5 disabled:opacity-40 transition-colors">
              forget host
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="font-mono text-[11px] text-muted/60">
              paste the pairing link from the host&rsquo;s phone-sync panel
            </label>
            <div className="flex gap-2">
              <input value={pairUri} onChange={(e) => setPairUri(e.target.value)}
                placeholder="offcut://pair/…"
                className="flex-1 font-mono text-[12px] px-2 py-1.5 rounded bg-chassis-soft border border-border/40 text-ink placeholder:text-muted/40 focus:outline-none focus:border-accent/50" />
              <button onClick={pair} disabled={busy !== null || !pairUri.trim()}
                className="font-mono text-[12px] px-3 py-1.5 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors">
                pair
              </button>
            </div>
          </div>

          <div className="font-mono text-[11px] text-muted/40">or enter it manually</div>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="space-y-1">
              <label className="block font-mono text-[10px] text-muted/60">host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.160"
                className="w-40 font-mono text-[12px] px-2 py-1.5 rounded bg-chassis-soft border border-border/40 text-ink placeholder:text-muted/40 focus:outline-none focus:border-accent/50" />
            </div>
            <div className="space-y-1">
              <label className="block font-mono text-[10px] text-muted/60">port</label>
              <input value={port} onChange={(e) => setPort(e.target.value)}
                className="w-20 font-mono text-[12px] px-2 py-1.5 rounded bg-chassis-soft border border-border/40 text-ink focus:outline-none focus:border-accent/50" />
            </div>
            <div className="space-y-1">
              <label className="block font-mono text-[10px] text-muted/60">token</label>
              <input value={token} onChange={(e) => setToken(e.target.value)} type="password"
                className="w-56 font-mono text-[12px] px-2 py-1.5 rounded bg-chassis-soft border border-border/40 text-ink focus:outline-none focus:border-accent/50" />
            </div>
            <button onClick={saveManual} disabled={busy !== null}
              className="font-mono text-[12px] px-3 py-1.5 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors">
              {busy === 'save' ? 'saving…' : 'connect'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
