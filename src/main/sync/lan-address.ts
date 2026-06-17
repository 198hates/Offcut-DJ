import { networkInterfaces } from 'os'

/** Non-internal IPv4 addresses this machine is reachable at on the LAN. */
export function getLanAddresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      // Node <18 reports family as 'IPv4'; newer can report 4 — accept both.
      const isV4 = ni.family === 'IPv4' || (ni.family as unknown as number) === 4
      if (isV4 && !ni.internal) out.push(ni.address)
    }
  }
  return out
}
