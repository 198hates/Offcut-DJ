// Pairing: decode the desktop's QR (offcut://pair/<base64url>) and persist the
// resulting connection. The token is a bearer credential, so it's stored in the
// OS keychain via expo-secure-store rather than plain AsyncStorage.

import * as SecureStore from 'expo-secure-store'

export interface Connection {
  host: string
  port: number
  token: string
  name: string
}

const KEY = 'offcut.pairing'

/** base64url → string. The pairing payload is ASCII JSON, so atob is enough. */
function b64urlToString(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  // atob is available on Hermes (RN ≥ 0.74).
  return atob(b64)
}

/** Parse `offcut://pair/<base64url>` into a Connection, or null if malformed. */
export function parsePairingUri(uri: string): Connection | null {
  const m = /^offcut:\/\/pair\/(.+)$/.exec(uri.trim())
  if (!m) return null
  try {
    const p = JSON.parse(b64urlToString(m[1])) as Partial<Connection> & { v?: number }
    if (p && p.v === 1 && p.host && p.port && p.token) {
      return { host: p.host, port: p.port, token: p.token, name: p.name ?? 'Offcut' }
    }
  } catch {
    /* malformed payload */
  }
  return null
}

/** Manual entry fallback: "host:port token" or "host port token". */
export function parseManual(input: string): Connection | null {
  const parts = input.trim().split(/[\s:]+/)
  if (parts.length < 3) return null
  const [host, portStr, token] = parts
  const port = Number(portStr)
  if (!host || !Number.isFinite(port) || !token) return null
  return { host, port, token, name: 'Offcut' }
}

export async function loadConnection(): Promise<Connection | null> {
  const s = await SecureStore.getItemAsync(KEY)
  return s ? (JSON.parse(s) as Connection) : null
}

export async function saveConnection(c: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(c))
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY)
}
