// Pairing + auth state for the phone-sync server, persisted as JSON in userData.
//
// A single high-entropy bearer token authorises paired devices; it's carried to
// the phone in the pairing QR. "Unpair all" rotates the token, instantly
// locking out every device. Paired devices are recorded (id + name) purely so
// the desktop UI can show what's connected — they aren't a security boundary.

import { randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface PairedDevice {
  id: string
  name: string
  firstSeen: string
  lastSeen: string
}

interface PairingState {
  token: string
  enabled: boolean
  port: number
  devices: PairedDevice[]
}

export const DEFAULT_SYNC_PORT = 47823

export class PairingStore {
  private state: PairingState

  constructor(private filePath: string) {
    this.state = this.load()
  }

  static newToken(): string {
    return randomBytes(24).toString('base64url')
  }

  private load(): PairingState {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PairingState>
        if (parsed && typeof parsed.token === 'string') {
          return {
            token: parsed.token,
            enabled: parsed.enabled ?? false,
            port: parsed.port ?? DEFAULT_SYNC_PORT,
            devices: Array.isArray(parsed.devices) ? parsed.devices : []
          }
        }
      }
    } catch {
      /* fall through to a fresh state */
    }
    const fresh: PairingState = { token: PairingStore.newToken(), enabled: false, port: DEFAULT_SYNC_PORT, devices: [] }
    this.persist(fresh)
    return fresh
  }

  private persist(state: PairingState = this.state): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(state, null, 2))
    } catch {
      /* best-effort persistence */
    }
  }

  get token(): string {
    return this.state.token
  }
  get enabled(): boolean {
    return this.state.enabled
  }
  get port(): number {
    return this.state.port
  }
  get devices(): PairedDevice[] {
    return this.state.devices
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled
    this.persist()
  }

  setPort(port: number): void {
    this.state.port = port
    this.persist()
  }

  /** Rotate the token, unpairing every device. */
  rotateToken(): void {
    this.state.token = PairingStore.newToken()
    this.state.devices = []
    this.persist()
  }

  /** Constant-time bearer-token check. */
  verify(token: string | null): boolean {
    if (!token) return false
    const a = Buffer.from(token)
    const b = Buffer.from(this.state.token)
    if (a.length !== b.length) return false
    try {
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  recordDevice(id: string | null, name: string | null): void {
    if (!id) return
    const now = new Date().toISOString()
    const existing = this.state.devices.find((d) => d.id === id)
    if (existing) {
      existing.lastSeen = now
      if (name) existing.name = name
    } else {
      this.state.devices.push({ id, name: name || 'Device', firstSeen: now, lastSeen: now })
    }
    this.persist()
  }

  removeDevice(id: string): void {
    this.state.devices = this.state.devices.filter((d) => d.id !== id)
    this.persist()
  }
}
