/**
 * ProLink B2B Capture page
 *
 * Three states:
 *   idle       — pre-flight: shows network interface picker + Start button
 *   connecting — spinner + status message
 *   active     — live player cards (both decks) + captured track list
 *
 * Push events from main (prolink:statusUpdate, prolink:trackCaptured,
 * prolink:sessionState, prolink:error) are wired on mount.
 */

import { useEffect, useRef, useState } from 'react'
import type { PlayerStatus, CapturedTrack, ProLinkNetworkIface, ProLinkSessionState } from '@shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtBpm(bpm: number | null): string {
  if (!bpm) return '—'
  return bpm.toFixed(1)
}

function fmtDuration(sec: number | null): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PlayerCard({ status }: { status: PlayerStatus }): JSX.Element {
  const isPlaying = status.playState === 'playing' || status.playState === 'looping'
  const isEmpty   = status.playState === 'empty'

  const stateColor = isEmpty
    ? 'text-muted'
    : isPlaying && status.isOnAir
    ? 'text-green-400'
    : isPlaying
    ? 'text-accent'
    : 'text-muted'

  const stateDot = isEmpty
    ? 'bg-border/40'
    : isPlaying && status.isOnAir
    ? 'bg-green-400 shadow-[0_0_6px_theme(colors.green.400)]'
    : isPlaying
    ? 'bg-accent'
    : 'bg-muted/50'

  return (
    <div className={`flex-1 min-w-[200px] rounded-lg border ${status.isOnAir ? 'border-green-500/40 bg-green-500/[0.04]' : 'border-border/30 bg-ink/[0.03]'} p-3 space-y-2.5`}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-muted">CDJ {status.deviceId}</span>
          {status.isMaster && (
            <span className="px-1 py-0.5 rounded bg-accent/20 font-mono text-[11px] text-accent uppercase tracking-[0.1em]">master</span>
          )}
          {status.isSync && (
            <span className="px-1 py-0.5 rounded bg-border/30 font-mono text-[11px] text-muted uppercase tracking-[0.1em]">sync</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${stateDot} transition-all`} />
          <span className={`font-mono text-[12px] uppercase tracking-[0.12em] ${stateColor}`}>
            {status.playState}
          </span>
        </div>
      </div>

      {/* Track info */}
      {isEmpty ? (
        <p className="font-mono text-[13px] text-muted/50 italic">no track loaded</p>
      ) : (
        <div className="space-y-0.5">
          <p className="font-mono text-[13px] text-ink leading-tight truncate" title={status.title ?? undefined}>
            {status.title ?? <span className="text-muted italic">unknown track</span>}
          </p>
          {status.artist && (
            <p className="font-mono text-[12px] text-muted truncate">{status.artist}</p>
          )}
          {status.label && (
            <p className="font-mono text-[11px] text-muted/60 truncate uppercase tracking-[0.08em]">{status.label}</p>
          )}
        </div>
      )}

      {/* BPM + key + beat */}
      {!isEmpty && (
        <div className="flex items-center gap-3 pt-0.5">
          <div className="space-y-0.5">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">bpm</p>
            <p className="font-mono text-[13px] text-ink">{fmtBpm(status.trackBPM)}</p>
          </div>
          {status.key && (
            <div className="space-y-0.5">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">key</p>
              <p className="font-mono text-[13px] text-ink">{status.key}</p>
            </div>
          )}
          {/* Beat indicator: 4 pips */}
          <div className="ml-auto flex items-end gap-0.5 pb-0.5">
            {[1, 2, 3, 4].map((b) => (
              <div
                key={b}
                className={`w-1 rounded-sm transition-all ${
                  status.beat === b
                    ? b === 1 ? 'h-3.5 bg-accent' : 'h-2.5 bg-accent/60'
                    : 'h-1.5 bg-border/40'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {/* On-air label */}
      {status.isOnAir && (
        <div className="flex items-center gap-1 pt-0.5">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-green-400/80">on air</span>
        </div>
      )}
    </div>
  )
}

interface CapturedRowProps {
  track: CapturedTrack
  index: number
  onImport: (id: string) => void
  importing: boolean
}

function CapturedRow({ track, index, onImport, importing }: CapturedRowProps): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 hover:bg-ink/[0.04] group border-b border-border/10 last:border-0">
      <span className="font-mono text-[12px] text-muted/50 w-5 shrink-0 text-right tabular-nums">{index + 1}</span>

      {/* Player badge */}
      <div className="w-4 h-4 rounded bg-accent/10 flex items-center justify-center shrink-0">
        <span className="font-mono text-[10px] text-accent/70">{track.player}</span>
      </div>

      {/* Title + artist */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="font-mono text-[13px] text-ink truncate">{track.title}</p>
        <p className="font-mono text-[11px] text-muted truncate">{track.artist || '—'}</p>
      </div>

      {/* Metadata chips */}
      <div className="hidden sm:flex items-center gap-2.5 shrink-0 text-muted">
        {track.label && (
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] truncate max-w-[80px]">
            {track.label}
          </span>
        )}
        {track.bpm   && <span className="font-mono text-[12px] tabular-nums">{fmtBpm(track.bpm)}</span>}
        {track.key   && <span className="font-mono text-[12px]">{track.key}</span>}
        {track.durationSeconds && (
          <span className="font-mono text-[12px] tabular-nums">{fmtDuration(track.durationSeconds)}</span>
        )}
      </div>

      <span className="font-mono text-[11px] text-muted/60 shrink-0">{fmtTime(track.capturedAt)}</span>

      {/* Import action — only shown for unowned tracks */}
      {!track.inLibrary && (
        <button
          onClick={() => onImport(track.id)}
          disabled={importing}
          className="shrink-0 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] rounded border border-accent/40 text-accent/80 hover:bg-accent/10 hover:text-accent transition-colors disabled:opacity-40 opacity-0 group-hover:opacity-100"
          title="Add to library as a discovery (file not yet acquired)"
        >
          + library
        </button>
      )}
      {track.inLibrary && (
        <span className="shrink-0 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] rounded bg-green-500/10 border border-green-500/20 text-green-400/70">
          yours
        </span>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ProLinkPage(): JSX.Element {
  const [sessionState, setSessionState] = useState<ProLinkSessionState>('idle')
  const [playerStatuses, setPlayerStatuses] = useState<PlayerStatus[]>([])
  const [capturedTracks, setCapturedTracks] = useState<CapturedTrack[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [ifaces, setIfaces] = useState<ProLinkNetworkIface[]>([])
  const [selectedIface, setSelectedIface] = useState<string>('')
  const [importingId, setImportingId] = useState<string | null>(null)
  const capturedEndRef = useRef<HTMLDivElement>(null)

  // Load initial state + register push listeners on mount
  useEffect(() => {
    window.api.prolink.getNetworkInterfaces().then((list) => {
      setIfaces(list)
      if (list.length === 1) setSelectedIface(list[0].address)
    }).catch(() => {})

    window.api.prolink.getSessionState().then((s) => {
      setSessionState(s.state as ProLinkSessionState)
      setPlayerStatuses(s.playerStatuses)
      setCapturedTracks(s.capturedTracks)
    }).catch(() => {})

    const offStatus   = window.api.prolink.onStatusUpdate((_e, statuses) => setPlayerStatuses(statuses))
    const offCaptured = window.api.prolink.onTrackCaptured((_e, track) => {
      setCapturedTracks((prev) => [...prev, track])
    })
    const offUpdated = window.api.prolink.onTrackUpdated((_e, updated) => {
      setCapturedTracks((prev) => prev.map((t) => t.id === updated.id ? updated : t))
    })
    const offError = window.api.prolink.onError((_e, msg) => {
      setErrorMsg(msg)
      setSessionState('error')
    })
    const offSession = window.api.prolink.onSessionState((_e, payload) => {
      setSessionState(payload.state as ProLinkSessionState)
      setPlayerStatuses(payload.playerStatuses)
      setCapturedTracks(payload.capturedTracks)
    })

    return () => { offStatus(); offCaptured(); offUpdated(); offError(); offSession() }
  }, [])

  // Auto-scroll captured list to bottom on new track
  useEffect(() => {
    capturedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [capturedTracks.length])

  const handleStart = async (): Promise<void> => {
    setErrorMsg(null)
    setSessionState('connecting')
    const result = await window.api.prolink.start(selectedIface || undefined)
    if (!result.ok) {
      setErrorMsg(result.error ?? 'Unknown error')
      setSessionState('error')
    }
    // state is pushed via prolink:sessionState event once main confirms active
  }

  const handleStop = async (): Promise<void> => {
    setSessionState('stopping')
    await window.api.prolink.stop()
    // state is pushed via prolink:sessionState event
  }

  const handleImport = async (capturedId: string): Promise<void> => {
    setImportingId(capturedId)
    try {
      const result = await window.api.prolink.importUnownedTrack(capturedId)
      if (result.ok && result.localTrackId) {
        setCapturedTracks((prev) =>
          prev.map((t) => t.id === capturedId
            ? { ...t, inLibrary: true, localTrackId: result.localTrackId! }
            : t
          )
        )
      }
    } finally {
      setImportingId(null)
    }
  }

  const isConnecting = sessionState === 'connecting'
  const isActive     = sessionState === 'active'
  const isStopping   = sessionState === 'stopping'
  const isIdle       = sessionState === 'idle' || sessionState === 'error'

  // Split captured tracks into two groups
  const ownedTracks      = capturedTracks.filter((t) => t.inLibrary)
  const discoveryTracks  = capturedTracks.filter((t) => !t.inLibrary)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border/30 flex items-center justify-between shrink-0 bg-chassis">
        <div className="flex items-center gap-2.5">
          <span className="text-accent">◉</span>
          <h1 className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-ink">ProLink Capture</h1>
          {isActive && (
            <span className="px-1.5 py-0.5 rounded bg-green-500/15 border border-green-500/30 font-mono text-[11px] text-green-400 uppercase tracking-[0.12em] animate-pulse">live</span>
          )}
          {isConnecting && (
            <span className="px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 font-mono text-[11px] text-accent uppercase tracking-[0.12em]">connecting…</span>
          )}
          {isStopping && (
            <span className="px-1.5 py-0.5 rounded bg-border/30 font-mono text-[11px] text-muted uppercase tracking-[0.12em]">stopping…</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {capturedTracks.length > 0 && (
            <span className="font-mono text-[12px] text-muted tabular-nums">
              {capturedTracks.length} captured
              {discoveryTracks.length > 0 && (
                <span className="text-amber-400/80"> · {discoveryTracks.length} new</span>
              )}
            </span>
          )}
          {isActive ? (
            <button
              onClick={handleStop}
              disabled={isStopping}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] bg-red-500/80 hover:bg-red-500 text-paper rounded transition-colors disabled:opacity-50"
            >
              stop capture
            </button>
          ) : isIdle ? (
            <button
              onClick={handleStart}
              disabled={isConnecting}
              className="px-3 py-1.5 font-mono text-[13px] uppercase tracking-[0.1em] bg-accent hover:bg-accent/90 text-paper rounded transition-colors disabled:opacity-50"
            >
              start capture
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Error banner */}
        {errorMsg && (
          <div className="px-5 py-2.5 bg-red-500/10 border-b border-red-500/20 flex items-start gap-2 shrink-0">
            <span className="text-red-400 text-sm mt-0.5">⚠</span>
            <div className="flex-1">
              <p className="font-mono text-[13px] text-red-400">{errorMsg}</p>
              <p className="font-mono text-[12px] text-muted/70 mt-0.5">
                Ensure OD-01 is on the same ethernet switch as your CDJs, and Rekordbox is not running on this machine.
              </p>
            </div>
          </div>
        )}

        {/* Idle state: pre-flight */}
        {isIdle && !isConnecting && (
          <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6">
            {/* NIC picker */}
            <div className="space-y-3 max-w-md">
              <div>
                <h2 className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted mb-1">network interface</h2>
                <p className="font-mono text-[12px] text-muted/70">
                  Select the ethernet adapter connected to the ProLink switch.
                  Leave blank to auto-detect from the first CDJ seen on the network.
                </p>
              </div>
              {ifaces.length === 0 ? (
                <p className="font-mono text-[13px] text-muted italic">No IPv4 interfaces found</p>
              ) : (
                <select
                  value={selectedIface}
                  onChange={(e) => setSelectedIface(e.target.value)}
                  className="bg-paper border border-border/40 rounded px-2 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent w-full max-w-sm"
                >
                  <option value="">auto-detect from peers…</option>
                  {ifaces.map((i) => (
                    <option key={i.address} value={i.address}>
                      {i.name} — {i.address}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Pre-flight checklist */}
            <div className="space-y-2 max-w-md">
              <h2 className="font-mono text-[12px] uppercase tracking-[0.15em] text-muted">pre-flight</h2>
              {[
                'OD-01 laptop is on the same ethernet switch as the CDJs',
                'Rekordbox is not running on this machine',
                'CDJs are powered on and connected to the switch',
                'A DJM mixer is on the network for on-air detection (recommended)',
              ].map((check) => (
                <div key={check} className="flex items-start gap-2">
                  <span className="text-muted/40 mt-0.5 shrink-0">○</span>
                  <span className="font-mono text-[12px] text-muted/70">{check}</span>
                </div>
              ))}
            </div>

            {/* Note about protocol */}
            <div className="max-w-md bg-ink/[0.03] border border-border/20 rounded-lg px-3 py-2.5 space-y-1">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted/60">note</p>
              <p className="font-mono text-[12px] text-muted/70 leading-relaxed">
                ProLink capture uses a reverse-engineered protocol. It may be affected by Pioneer firmware updates.
                Build version: prolink-connect 0.11.
              </p>
            </div>
          </div>
        )}

        {/* Connecting spinner */}
        {isConnecting && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto" />
              <p className="font-mono text-[13px] text-muted uppercase tracking-[0.14em]">
                {selectedIface ? 'connecting to network…' : 'waiting for peers…'}
              </p>
              <p className="font-mono text-[12px] text-muted/50">
                {selectedIface ? 'joining ProLink network' : 'auto-detecting interface from CDJ presence'}
              </p>
            </div>
          </div>
        )}

        {/* Active state */}
        {(isActive || isStopping) && (
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Player cards */}
            <div className="px-4 py-3 border-b border-border/20 shrink-0">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted/60 mb-2">
                {playerStatuses.length > 0 ? `${playerStatuses.length} player${playerStatuses.length !== 1 ? 's' : ''} on network` : 'scanning network…'}
              </p>
              {playerStatuses.length === 0 ? (
                <div className="flex items-center gap-2 text-muted">
                  <div className="w-4 h-4 border border-border/30 border-t-muted/50 rounded-full animate-spin" />
                  <span className="font-mono text-[13px]">waiting for CDJs…</span>
                </div>
              ) : (
                <div className="flex gap-3 flex-wrap">
                  {playerStatuses.map((ps) => (
                    <PlayerCard key={ps.deviceId} status={ps} />
                  ))}
                </div>
              )}
            </div>

            {/* Captured track list — two sections */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {capturedTracks.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center space-y-1">
                    <p className="font-mono text-[13px] text-muted/40">no tracks captured yet</p>
                    <p className="font-mono text-[12px] text-muted/30">
                      tracks appear once they've been on-air for 64+ beats
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">

                  {/* ── Discoveries — tracks not in your library ─────────── */}
                  {discoveryTracks.length > 0 && (
                    <div>
                      <div className="px-4 py-1.5 flex items-center gap-2 bg-amber-500/[0.04] border-b border-amber-500/15 sticky top-0">
                        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-400/80">
                          ✦ discoveries
                        </span>
                        <span className="font-mono text-[11px] text-muted/50">
                          {discoveryTracks.length} track{discoveryTracks.length !== 1 ? 's' : ''} not in your library
                        </span>
                        <span className="ml-auto font-mono text-[10px] text-muted/40">
                          hover to add → library
                        </span>
                      </div>
                      {discoveryTracks.map((t, i) => (
                        <CapturedRow
                          key={t.id}
                          track={t}
                          index={i}
                          onImport={handleImport}
                          importing={importingId === t.id}
                        />
                      ))}
                    </div>
                  )}

                  {/* ── Yours — tracks already in your library ───────────── */}
                  {ownedTracks.length > 0 && (
                    <div>
                      <div className="px-4 py-1.5 flex items-center gap-2 bg-green-500/[0.03] border-b border-green-500/10 border-t border-t-border/20 sticky top-0">
                        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-green-400/70">
                          ✓ yours
                        </span>
                        <span className="font-mono text-[11px] text-muted/50">
                          {ownedTracks.length} track{ownedTracks.length !== 1 ? 's' : ''} in your library
                        </span>
                      </div>
                      {ownedTracks.map((t, i) => (
                        <CapturedRow
                          key={t.id}
                          track={t}
                          index={discoveryTracks.length + i}
                          onImport={handleImport}
                          importing={false}
                        />
                      ))}
                    </div>
                  )}

                  <div ref={capturedEndRef} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
