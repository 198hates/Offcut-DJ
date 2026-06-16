// Google Cast — de-risking test panel (Settings › General).
//
// Confirms the cast chain on real hardware: discover devices over mDNS, then
// stream the track currently loaded on Deck A to a chosen device as live HLS.
// (Streaming the live MASTER MIX — for automix as an audience PA — is the
// planned follow-on once this proves the device + HLS + protocol path works.)

import { useState, useEffect, useCallback } from 'react'
import type { CastDevice, CastStatus } from '@shared/types'
import { useDeckAStore } from '../store/playerStore'

export function CastPanel(): JSX.Element {
  const [devices, setDevices] = useState<CastDevice[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<CastStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const deckATrack = useDeckAStore((s) => s.currentTrack)

  const refresh = useCallback(() => { window.api.cast.status().then(setStatus).catch(() => {}) }, [])
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try { setDevices(await window.api.cast.discover()) }
    catch (e) { setError(String((e as Error).message ?? e)) }
    finally { setScanning(false) }
  }, [])

  const cast = useCallback(async (d: CastDevice) => {
    if (!deckATrack) { setError('Load a track on Deck A first'); return }
    setBusy(true)
    setError(null)
    try { await window.api.cast.start(d, deckATrack.filePath); await refresh() }
    catch (e) { setError(String((e as Error).message ?? e)) }
    finally { setBusy(false) }
  }, [deckATrack, refresh])

  const stop = useCallback(async () => {
    setBusy(true)
    try { await window.api.cast.stop(); await refresh() }
    finally { setBusy(false) }
  }, [refresh])

  return (
    <div className="space-y-3">
      <p className="font-mono text-[12px] text-muted">
        test cast: streams <span className="text-ink">Deck A’s loaded track</span> to a Cast device as live HLS,
        to confirm discovery + streaming work on your hardware. casting the live master mix (for automix as an
        audience PA) is the next step. expect a few seconds of latency — fine for audience playback, not for monitoring.
      </p>

      <div className="flex items-center gap-2">
        <button
          onClick={scan}
          disabled={scanning}
          className="font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border border-border/40 text-muted hover:text-ink hover:border-border/60 transition-colors disabled:opacity-40"
        >
          {scanning ? 'scanning…' : 'scan for devices'}
        </button>
        {status?.casting && (
          <button
            onClick={stop}
            disabled={busy}
            className="font-mono text-[12px] uppercase tracking-[0.1em] px-3 py-1.5 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          >
            stop cast
          </button>
        )}
      </div>

      {status?.casting && (
        <p className="font-mono text-[12px] text-accent">
          ● casting to <span className="text-ink">{status.device}</span>
          {status.source && <span className="text-muted"> · {status.source.split('/').pop()}</span>}
        </p>
      )}

      {error && <p className="font-mono text-[12px] text-red-500">⚠ {error}</p>}

      {devices.length > 0 && (
        <div className="rounded border border-border/30 bg-paper/40 divide-y divide-border/20">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between px-3 py-2">
              <div className="min-w-0">
                <p className="font-mono text-[13px] text-ink truncate">{d.name}</p>
                <p className="font-mono text-[11px] text-muted/60">{d.host}</p>
              </div>
              <button
                onClick={() => cast(d)}
                disabled={busy || !deckATrack}
                title={deckATrack ? `Cast: ${deckATrack.title}` : 'Load a track on Deck A first'}
                className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] px-2.5 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors disabled:opacity-40"
              >
                ▶ cast deck A
              </button>
            </div>
          ))}
        </div>
      )}

      {!scanning && devices.length === 0 && (
        <p className="font-mono text-[12px] text-muted/60">no devices yet — scan while a Chromecast / Cast speaker is on the same network.</p>
      )}
    </div>
  )
}
