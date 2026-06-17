/**
 * PhoneSyncPanel — control the LAN sync server the mobile companion connects to.
 *
 * Toggle the server on, show a pairing QR (and the host/token behind it for
 * manual entry), and manage paired devices. The server is read-only for now:
 * it serves the library delta to the phone; pushing edits back lands next.
 */

import { useCallback, useEffect, useState } from 'react'
import { useToastStore } from '../store/toastStore'
import type { SyncStatus, SyncPairingInfo } from '@shared/types'

function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function PhoneSyncPanel(): JSX.Element {
  const showToast = useToastStore((s) => s.show)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [pairing, setPairing] = useState<SyncPairingInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPairing, setShowPairing] = useState(false)

  const refresh = useCallback(async () => {
    setStatus(await window.api.sync.status())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadPairing = useCallback(async () => {
    setPairing(await window.api.sync.pairing())
  }, [])

  const toggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true)
      const res = await window.api.sync.setEnabled(enabled)
      setBusy(false)
      if ('error' in res) {
        showToast(`Couldn't ${enabled ? 'start' : 'stop'} phone sync: ${res.error}`, 'error')
        await refresh()
        return
      }
      setStatus(res)
      if (enabled) {
        await loadPairing()
        setShowPairing(true)
      } else {
        setShowPairing(false)
      }
    },
    [showToast, refresh, loadPairing]
  )

  const unpairAll = useCallback(async () => {
    setStatus(await window.api.sync.unpairAll())
    await loadPairing() // token rotated → refresh the QR
    showToast('All devices unpaired — scan the new code to reconnect', 'info')
  }, [loadPairing, showToast])

  const removeDevice = useCallback(async (id: string) => {
    setStatus(await window.api.sync.removeDevice(id))
  }, [])

  if (!status) return <div className="font-mono text-[12px] text-muted/60">Loading…</div>

  return (
    <div className="space-y-3">
      {/* Enable toggle */}
      <label className="flex items-center gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
          className="accent-accent"
        />
        <span className="font-mono text-[12px] text-ink-soft">
          Enable phone sync
          {status.enabled && (
            <span className={status.running ? 'text-green-400/80' : 'text-amber-400/80'}>
              {' '}· {status.running ? 'running' : 'starting…'}
            </span>
          )}
        </span>
      </label>
      <p className="font-mono text-[11px] text-muted/60 leading-relaxed pl-6">
        Lets the Offcut mobile app prep on the same WiFi. Your library never leaves your network — the
        phone connects straight to this machine.
      </p>

      {status.enabled && (
        <div className="pl-6 space-y-3">
          {/* Pairing */}
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!pairing) await loadPairing()
                setShowPairing((v) => !v)
              }}
              className="font-mono text-[11px] px-2 py-0.5 rounded border border-accent/40 text-accent/90 hover:text-accent"
            >
              {showPairing ? 'hide pairing code' : 'show pairing code'}
            </button>
            {status.addresses.length > 0 && (
              <span className="font-mono text-[11px] text-muted/50 tabular-nums">
                {status.addresses[0]}:{status.port}
              </span>
            )}
          </div>

          {showPairing && pairing && (
            <div className="flex items-start gap-3 p-2.5 rounded border border-border/30 bg-ink/[0.02]">
              {pairing.qr ? (
                <img src={pairing.qr} width={120} height={120} alt="Pairing QR" className="rounded bg-white p-1 shrink-0" />
              ) : (
                <div className="w-[120px] h-[120px] grid place-items-center text-muted/40 text-[10px] shrink-0">
                  no QR
                </div>
              )}
              <div className="space-y-1.5 min-w-0">
                <div className="font-mono text-[11px] text-ink-soft">Scan in the Offcut mobile app</div>
                <div className="font-mono text-[10px] text-muted/60 leading-relaxed break-all">
                  or enter manually:
                  <br />
                  host <span className="text-ink-soft">{pairing.host}</span> · port{' '}
                  <span className="text-ink-soft">{pairing.port}</span>
                </div>
                {status.addresses.length > 1 && (
                  <div className="font-mono text-[10px] text-muted/40">
                    other addresses: {status.addresses.slice(1).join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Paired devices */}
          <div className="space-y-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted/50">
              paired devices ({status.devices.length})
            </div>
            {status.devices.length === 0 ? (
              <div className="font-mono text-[11px] text-muted/40">None yet — scan the code on your phone.</div>
            ) : (
              <div className="rounded border border-border/30 divide-y divide-border/10">
                {status.devices.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-2 py-1">
                    <span className="font-mono text-[12px] text-ink-soft truncate flex-1">{d.name}</span>
                    <span className="font-mono text-[10px] text-muted/40 tabular-nums shrink-0">
                      {timeAgo(d.lastSeen)}
                    </span>
                    <button
                      onClick={() => removeDevice(d.id)}
                      className="font-mono text-[10px] text-muted/50 hover:text-red-400 shrink-0"
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {status.devices.length > 0 && (
              <button onClick={unpairAll} className="font-mono text-[10px] text-muted/50 hover:text-red-400">
                unpair all &amp; rotate code
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
