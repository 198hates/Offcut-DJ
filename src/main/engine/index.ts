/**
 * Native audio engine — main process host.
 *
 * Loads the compiled Rust addon (native/audio-engine → crate-audio-engine.node)
 * and exposes its DeckHandle objects for decks A and B.
 * Registers all `engine:*` IPC handlers.
 *
 * Falls back gracefully when the .node file is not yet compiled — the renderer
 * will continue to use the Web Audio engine transparently.
 *
 * id·2026·009 — Phase 2
 */

import { ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { app } from 'electron'

// ── Native addon types (mirrors the Rust N-API exports) ──────────────────────

interface NativeLoadResult {
  durationMs: number
  peaks: number[]
  detailPeaks: number[]
  lowPeaks: number[]
  midPeaks: number[]
  highPeaks: number[]
  sampleRate: number
}

interface DeckHandle {
  load(filePath: string): Promise<NativeLoadResult>
  play(fromMs?: number): void
  pause(): void
  seek(ms: number): void
  stop(): void
  setVolume(v: number): void
  setRate(r: number): void
  setKeylock(enabled: boolean): void
  setEqGain(band: string, db: number): void
  setStemGain(kind: string, db: number): void
  setStemMuted(kind: string, muted: boolean): void
  setStemSoloed(kind: string, soloed: boolean): void
  setLoop(startMs: number, endMs: number): void
  clearLoop(): void
  setOutputDevice(deviceId: string): Promise<void>
  getTimeMs(): number
  getDurationMs(): number
  getLevel(): number
  onTimeUpdate(cb: (ms: number) => void): void
  onEnded(cb: () => void): void
}

interface NativeEngineAddon {
  createDeck(deckId: string, outputDevice?: string): DeckHandle
  listOutputDevices(): string[]
}

// ── Singleton state ──────────────────────────────────────────────────────────

let addon: NativeEngineAddon | null = null
const decks = new Map<string, DeckHandle>()
let _nativeAvailable = false

/** Load the compiled .node addon. Returns true if successful. */
export function loadNativeEngine(): boolean {
  if (addon) return true
  try {
    // The addon is unpacked from the asar alongside the main bundle.
    // In development: look in the project root's native build output.
    // In production: electron-builder unpacks to app.getPath('exe')/../…
    const candidates = [
      // napi-rs output (development / CI build)
      path.join(__dirname, '..', '..', 'native', 'audio-engine', 'crate-audio-engine.node'),
      // Production (electron-builder unpacked)
      path.join(path.dirname(app.getPath('exe')), 'resources', 'extraResources', 'crate-audio-engine.node'),
      // Fallback: adjacent to main bundle
      path.join(__dirname, 'crate-audio-engine.node'),
    ]

    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        addon = require(candidate) as NativeEngineAddon
        console.log(`[NativeEngine] loaded from ${candidate}`)
        _nativeAvailable = true
        return true
      } catch {
        // try next candidate
      }
    }

    console.info('[NativeEngine] .node addon not found — renderer will use Web Audio engine')
    return false
  } catch (err) {
    console.warn('[NativeEngine] failed to load:', err)
    return false
  }
}

/** True once the .node addon is loaded and initialised. */
export function isNativeAvailable(): boolean { return _nativeAvailable }

// ── Deck helpers ──────────────────────────────────────────────────────────────

function getDeck(deckId: string): DeckHandle {
  if (!addon) throw new Error('Native engine not loaded')
  if (!decks.has(deckId)) {
    const deck = addon.createDeck(deckId)
    decks.set(deckId, deck)

    // Wire time-update events → push to all renderer windows (includes RMS level)
    deck.onTimeUpdate((ms) => {
      const level = deck.getLevel()
      BrowserWindow.getAllWindows().forEach((w) => {
        w.webContents.send('engine:timeUpdate', deckId, ms / 1000, level)
      })
    })

    // Wire ended events
    deck.onEnded(() => {
      BrowserWindow.getAllWindows().forEach((w) => {
        w.webContents.send('engine:ended', deckId)
      })
    })
  }
  return decks.get(deckId)!
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

/** Register all engine:* IPC handlers. Call once from main process startup. */
export function registerEngineHandlers(): void {
  // ── Status ──────────────────────────────────────────────────────────────
  ipcMain.handle('engine:isAvailable', () => _nativeAvailable)

  ipcMain.handle('engine:listOutputDevices', () => {
    if (!addon) return []
    try { return addon.listOutputDevices() } catch { return [] }
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────
  ipcMain.handle('engine:load', async (_e, deckId: string, filePath: string) => {
    const deck = getDeck(deckId)
    const result = await deck.load(filePath)
    return {
      duration:    result.durationMs / 1000,
      peaks:       result.peaks,
      detailPeaks: result.detailPeaks,
      lowPeaks:    result.lowPeaks,
      midPeaks:    result.midPeaks,
      highPeaks:   result.highPeaks,
    }
  })

  // ── Playback ─────────────────────────────────────────────────────────────
  ipcMain.on('engine:play',  (_e, deckId: string, fromMs?: number) => {
    try { getDeck(deckId).play(fromMs) } catch (err) { console.error(err) }
  })
  ipcMain.on('engine:pause', (_e, deckId: string) => {
    try { getDeck(deckId).pause() } catch (err) { console.error(err) }
  })
  ipcMain.on('engine:seek',  (_e, deckId: string, ms: number) => {
    try { getDeck(deckId).seek(ms) } catch (err) { console.error(err) }
  })

  // ── Settings ─────────────────────────────────────────────────────────────
  ipcMain.on('engine:setVolume',  (_e, deckId: string, v: number)    => { try { getDeck(deckId).setVolume(v)   } catch {} })
  ipcMain.on('engine:setRate',    (_e, deckId: string, r: number)    => { try { getDeck(deckId).setRate(r)     } catch {} })
  ipcMain.on('engine:setKeylock', (_e, deckId: string, v: boolean)   => { try { getDeck(deckId).setKeylock(v)  } catch {} })
  ipcMain.on('engine:setEqGain',  (_e, deckId: string, band: string, db: number) => { try { getDeck(deckId).setEqGain(band, db)  } catch {} })
  ipcMain.on('engine:setStemGain',   (_e, deckId: string, kind: string, db: number)      => { try { getDeck(deckId).setStemGain(kind, db)   } catch {} })
  ipcMain.on('engine:setStemMuted',  (_e, deckId: string, kind: string, muted: boolean)  => { try { getDeck(deckId).setStemMuted(kind, muted) } catch {} })
  ipcMain.on('engine:setStemSoloed', (_e, deckId: string, kind: string, soloed: boolean) => { try { getDeck(deckId).setStemSoloed(kind, soloed) } catch {} })

  // ── Loop ──────────────────────────────────────────────────────────────────
  ipcMain.on('engine:setLoop',   (_e, deckId: string, startMs: number, endMs: number) => { try { getDeck(deckId).setLoop(startMs, endMs) } catch {} })
  ipcMain.on('engine:clearLoop', (_e, deckId: string) => { try { getDeck(deckId).clearLoop() } catch {} })

  // ── Output ────────────────────────────────────────────────────────────────
  ipcMain.handle('engine:setOutputDevice', async (_e, deckId: string, deviceId: string) => {
    await getDeck(deckId).setOutputDevice(deviceId)
  })

  // ── Getters (sync invoke) ─────────────────────────────────────────────────
  ipcMain.handle('engine:getTime',  (_e, deckId: string) => {
    try { return getDeck(deckId).getTimeMs() / 1000 } catch { return 0 }
  })
  ipcMain.handle('engine:getLevel', (_e, deckId: string) => {
    try { return getDeck(deckId).getLevel() } catch { return 0 }
  })
}
