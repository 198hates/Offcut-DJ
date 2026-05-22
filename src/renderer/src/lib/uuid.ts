/** Renderer-safe UUID v4 — uses the Web Crypto API (always available in Electron/Chromium). */
export function randomUUID(): string {
  return crypto.randomUUID()
}
