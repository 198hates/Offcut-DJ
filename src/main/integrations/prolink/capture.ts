/**
 * ProLink Capture Engine
 *
 * Joins the Pioneer DJ Link network as a virtual CDJ, observes live player
 * status for all connected decks, and fires "captured" events when a track
 * passes the mixstatus "played" gate (on-air + beat threshold).
 *
 * Works against `prolink-connect` v0.11 — unsanctioned, version-pinned.
 * Defensive: every async operation is try/catched; callbacks never throw.
 */

import { networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
import {
  bringOnline,
  CDJStatus,
  MixstatusMode,
} from 'prolink-connect'
import type {
  ProlinkNetwork,
  ConnectedProlinkNetwork,
  NetworkConfig,
} from 'prolink-connect'
import type { NetworkInterfaceInfoIPv4 } from 'os'
import type {
  PlayerStatus,
  CapturedTrack,
  ProLinkPlayState,
  ProLinkNetworkIface,
} from '../../../shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapPlayState(ps: CDJStatus.PlayState): ProLinkPlayState {
  switch (ps) {
    case CDJStatus.PlayState.Playing:     return 'playing'
    case CDJStatus.PlayState.Paused:      return 'paused'
    case CDJStatus.PlayState.Cued:        return 'cued'
    case CDJStatus.PlayState.Cuing:       return 'cued'
    case CDJStatus.PlayState.Looping:     return 'looping'
    case CDJStatus.PlayState.Loading:     return 'loading'
    case CDJStatus.PlayState.Ended:       return 'ended'
    case CDJStatus.PlayState.Empty:       return 'empty'
    case CDJStatus.PlayState.SpunDown:    return 'paused'
    case CDJStatus.PlayState.PlatterHeld: return 'playing'
    default:                              return 'unknown'
  }
}

/** List all non-loopback IPv4 interfaces on this machine. */
export function listNetworkInterfaces(): ProLinkNetworkIface[] {
  const result: ProLinkNetworkIface[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac,
        })
      }
    }
  }
  return result
}

// ── Metadata cache ────────────────────────────────────────────────────────────

interface TrackMeta {
  title: string | null
  artist: string | null
  album: string | null
  label: string | null
  genre: string | null
  key: string | null
  year: number | null
  bpm: number | null
  durationSeconds: number | null
}

const EMPTY_META: TrackMeta = {
  title: null, artist: null, album: null, label: null,
  genre: null, key: null, year: null, bpm: null, durationSeconds: null,
}

// ── Capture engine ────────────────────────────────────────────────────────────

type StatusCallback   = (statuses: PlayerStatus[]) => void
type CapturedCallback = (track: CapturedTrack) => void
type ErrorCallback    = (message: string) => void

export class ProLinkCapture {
  private network: ProlinkNetwork | null = null
  private connected: ConnectedProlinkNetwork | null = null

  private onStatus:   StatusCallback   = () => {}
  private onCaptured: CapturedCallback = () => {}
  private onError:    ErrorCallback    = () => {}

  // Per-device live state
  private playerMap = new Map<number, PlayerStatus>()
  // Metadata cache keyed by "deviceId:slot:trackId"
  private metaCache = new Map<string, TrackMeta>()
  // Track which devices currently have in-flight metadata fetches
  private metaPending = new Set<string>()

  setOnStatus  (cb: StatusCallback):   void { this.onStatus   = cb }
  setOnCaptured(cb: CapturedCallback): void { this.onCaptured = cb }
  setOnError   (cb: ErrorCallback):    void { this.onError    = cb }

  /**
   * Start the capture session.
   * Autoconfigures the network interface from peers, then connects.
   */
  async start(): Promise<void> {
    try {
      this.network = await bringOnline()
      await this.network.autoconfigFromPeers()
      this.network.connect()

      if (!this.network.isConnected()) {
        this.onError('ProLink network connected but services unavailable')
        return
      }

      this.connected = this.network as ConnectedProlinkNetwork
      this._subscribeStatus()
      this._subscribeMixstatus()
    } catch (err) {
      this.onError(`Failed to start ProLink capture: ${(err as Error).message}`)
      await this.stop().catch(() => {})
    }
  }

  /**
   * Start with an explicit network interface (skips autoconfig peer wait).
   */
  async startWithIface(iface: ProLinkNetworkIface): Promise<void> {
    try {
      // Find the full NetworkInterfaceInfoIPv4 from os.networkInterfaces()
      const osIfaces = networkInterfaces()
      let found: NetworkInterfaceInfoIPv4 | undefined
      for (const addrs of Object.values(osIfaces)) {
        for (const addr of addrs ?? []) {
          if (addr.family === 'IPv4' && addr.address === iface.address) {
            found = addr as NetworkInterfaceInfoIPv4
            break
          }
        }
        if (found) break
      }

      if (!found) {
        this.onError(`Network interface ${iface.address} not found`)
        return
      }

      const config: NetworkConfig = { iface: found, vcdjId: 5 }
      this.network = await bringOnline(config)
      this.network.connect()

      if (!this.network.isConnected()) {
        this.onError('ProLink network connected but services unavailable')
        return
      }

      this.connected = this.network as ConnectedProlinkNetwork
      this._subscribeStatus()
      this._subscribeMixstatus()
    } catch (err) {
      this.onError(`Failed to start ProLink capture: ${(err as Error).message}`)
      await this.stop().catch(() => {})
    }
  }

  async stop(): Promise<CapturedTrack[]> {
    const captured = this._getCapturedSoFar()
    try {
      if (this.network) {
        await this.network.disconnect()
      }
    } catch { /* ignore disconnect errors */ }
    this.network = null
    this.connected = null
    this.playerMap.clear()
    this.metaCache.clear()
    this.metaPending.clear()
    return captured
  }

  getPlayerStatuses(): PlayerStatus[] {
    return [...this.playerMap.values()].sort((a, b) => a.deviceId - b.deviceId)
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _capturedTracks: CapturedTrack[] = []

  private _getCapturedSoFar(): CapturedTrack[] {
    return [...this._capturedTracks]
  }

  private _subscribeStatus(): void {
    if (!this.connected) return

    this.connected.statusEmitter.on('status', (state: CDJStatus.State) => {
      try {
        this._handleStatusUpdate(state)
      } catch { /* swallow per-status errors */ }
    })
  }

  private _handleStatusUpdate(state: CDJStatus.State): void {
    const existing = this.playerMap.get(state.deviceId)
    const cacheKey = `${state.trackDeviceId}:${state.trackSlot}:${state.trackId}`
    const meta = this.metaCache.get(cacheKey) ?? EMPTY_META

    const ps: PlayerStatus = {
      deviceId:    state.deviceId,
      playState:   mapPlayState(state.playState),
      isOnAir:     state.isOnAir,
      isMaster:    state.isMaster,
      isSync:      state.isSync,
      trackBPM:    state.trackBPM,
      beat:        state.beatInMeasure,
      trackId:     state.trackId,
      title:       meta.title,
      artist:      meta.artist,
      album:       meta.album,
      label:       meta.label,
      genre:       meta.genre,
      key:         meta.key,
      year:        meta.year,
      lastUpdated: new Date().toISOString(),
    }

    this.playerMap.set(state.deviceId, ps)

    // Kick off a metadata fetch if this device just loaded a new track
    if (
      state.trackId !== 0 &&
      (existing?.trackId !== state.trackId || !this.metaCache.has(cacheKey)) &&
      !this.metaPending.has(cacheKey)
    ) {
      this._fetchMeta(state, cacheKey)
    }

    // Push updated statuses to renderer
    this.onStatus(this.getPlayerStatuses())
  }

  private async _fetchMeta(state: CDJStatus.State, cacheKey: string): Promise<void> {
    if (!this.connected) return
    this.metaPending.add(cacheKey)

    try {
      const track = await this.connected.db.getMetadata({
        deviceId:  state.trackDeviceId,
        trackSlot: state.trackSlot,
        trackType: state.trackType,
        trackId:   state.trackId,
      })

      if (track) {
        const meta: TrackMeta = {
          title:           track.title ?? null,
          artist:          track.artist?.name ?? null,
          album:           track.album?.name ?? null,
          label:           track.label?.name ?? null,
          genre:           track.genre?.name ?? null,
          key:             track.key?.name ?? null,
          year:            track.year ?? null,
          bpm:             track.tempo ? track.tempo / 100 : null,
          durationSeconds: track.duration ?? null,
        }
        this.metaCache.set(cacheKey, meta)

        // Refresh any players currently showing this track
        for (const [deviceId, ps] of this.playerMap.entries()) {
          if (
            `${state.trackDeviceId}:${state.trackSlot}:${state.trackId}` === cacheKey &&
            ps.trackId === state.trackId
          ) {
            this.playerMap.set(deviceId, { ...ps, ...meta, lastUpdated: new Date().toISOString() })
          }
        }
        this.onStatus(this.getPlayerStatuses())
      }
    } catch { /* metadata fetch can fail for unanalyzed/CD tracks */ } finally {
      this.metaPending.delete(cacheKey)
    }
  }

  private _subscribeMixstatus(): void {
    if (!this.connected) return

    this.connected.mixstatus.configure({
      mode: MixstatusMode.SmartTiming,
      useOnAirStatus: true,
      beatsUntilReported: 64,   // ~2 phrases = track is genuinely playing
      allowedInterruptBeats: 8,
      timeBetweenSets: 30,
    })

    this.connected.mixstatus.on('nowPlaying', (state: CDJStatus.State) => {
      this._handleNowPlaying(state).catch(() => {})
    })
  }

  private async _handleNowPlaying(state: CDJStatus.State): Promise<void> {
    if (!this.connected) return

    // Get latest metadata (may already be cached)
    const cacheKey = `${state.trackDeviceId}:${state.trackSlot}:${state.trackId}`
    let meta = this.metaCache.get(cacheKey)

    if (!meta) {
      try {
        const track = await this.connected.db.getMetadata({
          deviceId:  state.trackDeviceId,
          trackSlot: state.trackSlot,
          trackType: state.trackType,
          trackId:   state.trackId,
        })
        if (track) {
          meta = {
            title:           track.title ?? null,
            artist:          track.artist?.name ?? null,
            album:           track.album?.name ?? null,
            label:           track.label?.name ?? null,
            genre:           track.genre?.name ?? null,
            key:             track.key?.name ?? null,
            year:            track.year ?? null,
            bpm:             track.tempo ? track.tempo / 100 : null,
            durationSeconds: track.duration ?? null,
          }
          this.metaCache.set(cacheKey, meta)
        }
      } catch { /* degrade gracefully */ }
    }

    const m = meta ?? EMPTY_META
    const captured: CapturedTrack = {
      id:              randomUUID(),
      player:          state.deviceId,
      capturedAt:      new Date().toISOString(),
      title:           m.title ?? `Track ${state.trackId}`,
      artist:          m.artist ?? '',
      album:           m.album ?? '',
      label:           m.label ?? '',
      genre:           m.genre ?? '',
      key:             m.key,
      bpm:             m.bpm ?? (state.trackBPM ?? null),
      year:            m.year,
      durationSeconds: m.durationSeconds,
      inLibrary:       false,  // TODO: resolve against local library by path/fingerprint
      localTrackId:    null,
      sourcedFrom:     'prolink',
    }

    this._capturedTracks.push(captured)
    this.onCaptured(captured)
  }
}
