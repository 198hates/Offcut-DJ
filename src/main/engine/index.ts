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

import { ipcMain, BrowserWindow, app, shell } from 'electron'
import path from 'path'
import fs from 'fs'

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
  scrubBegin(): void
  scrubEnd(): void
  stop(): void
  setVolume(v: number): void
  setRate(r: number): void
  setKeylock(enabled: boolean): void
  setEqGain(band: string, db: number): void
  setFilter(knob: number): void
  setDelay(timeMs: number, feedback: number, mix: number, enabled: boolean): void
  setStemGain(kind: string, db: number): void
  setStemMuted(kind: string, muted: boolean): void
  setStemSoloed(kind: string, soloed: boolean): void
  loadStems(drums: string, bass: string, vocals: string, other: string): Promise<void>
  unloadStems(): void
  hasStems(): boolean
  syncTo(masterDeckId: string, ratio: number, phaseSecs: number): void
  updateSync(ratio: number, phaseSecs: number): void
  clearSync(): void
  isSynced(): boolean
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
  // NOTE: napi sync fns surface Result::Err as a RETURNED Error value, not a
  // thrown exception — callers must check `instanceof Error`.
  startRecording(path: string): undefined | Error
  stopRecording(): { path: string; seconds: number } | Error
  isRecording(): boolean
}

// ── Singleton state ──────────────────────────────────────────────────────────

let addon: NativeEngineAddon | null = null
const decks = new Map<string, DeckHandle>()
let _nativeAvailable = false

/** Load the compiled .node addon. Returns true if successful. */
export function loadNativeEngine(): boolean {
  if (addon) return true
  try {
    const candidates = [
      // Development: refreshed by `npm run engine:build` / `engine:dev`
      // (scripts/copy-engine.js) — NOT under out/, which electron-vite wipes.
      path.join(__dirname, '..', '..', 'native', 'audio-engine', 'crate-audio-engine.node'),
      // Production: packed by electron-builder extraResources → Contents/Resources.
      path.join(process.resourcesPath, 'crate-audio-engine.node'),
      // Fallback: adjacent to the main bundle (legacy copies).
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
  ipcMain.on('engine:scrubBegin', (_e, deckId: string) => { try { getDeck(deckId).scrubBegin() } catch {} })
  ipcMain.on('engine:scrubEnd',   (_e, deckId: string) => { try { getDeck(deckId).scrubEnd()   } catch {} })

  // ── Settings ─────────────────────────────────────────────────────────────
  ipcMain.on('engine:setVolume',  (_e, deckId: string, v: number)    => { try { getDeck(deckId).setVolume(v)   } catch {} })
  ipcMain.on('engine:setRate',    (_e, deckId: string, r: number)    => { try { getDeck(deckId).setRate(r)     } catch {} })
  ipcMain.on('engine:setKeylock', (_e, deckId: string, v: boolean)   => { try { getDeck(deckId).setKeylock(v)  } catch {} })
  ipcMain.on('engine:setEqGain',  (_e, deckId: string, band: string, db: number) => { try { getDeck(deckId).setEqGain(band, db)  } catch {} })
  ipcMain.on('engine:setFilter',  (_e, deckId: string, knob: number) => { try { getDeck(deckId).setFilter(knob) } catch {} })
  ipcMain.on('engine:setDelay',   (_e, deckId: string, timeMs: number, feedback: number, mix: number, enabled: boolean) => { try { getDeck(deckId).setDelay(timeMs, feedback, mix, enabled) } catch {} })
  ipcMain.on('engine:setStemGain',   (_e, deckId: string, kind: string, db: number)      => { try { getDeck(deckId).setStemGain(kind, db)   } catch {} })
  ipcMain.on('engine:setStemMuted',  (_e, deckId: string, kind: string, muted: boolean)  => { try { getDeck(deckId).setStemMuted(kind, muted) } catch {} })
  ipcMain.on('engine:setStemSoloed', (_e, deckId: string, kind: string, soloed: boolean) => { try { getDeck(deckId).setStemSoloed(kind, soloed) } catch {} })

  // ── Stem buses (decode 4 files in Rust, play on independent buses) ─────────
  ipcMain.handle('engine:loadStems', async (_e, deckId: string, paths: Record<string, string>) => {
    await getDeck(deckId).loadStems(paths.drums, paths.bass, paths.vocals, paths.other)
  })
  ipcMain.on('engine:unloadStems', (_e, deckId: string) => { try { getDeck(deckId).unloadStems() } catch {} })
  ipcMain.handle('engine:hasStems', (_e, deckId: string) => {
    try { return getDeck(deckId).hasStems() } catch { return false }
  })

  // ── Sync (shared clock — slave one deck to another's transport) ────────────
  ipcMain.on('engine:syncTo', (_e, deckId: string, masterDeckId: string, ratio: number, phaseSecs: number) => {
    try { getDeck(deckId).syncTo(masterDeckId, ratio, phaseSecs) } catch (err) { console.error(err) }
  })
  ipcMain.on('engine:updateSync', (_e, deckId: string, ratio: number, phaseSecs: number) => {
    try { getDeck(deckId).updateSync(ratio, phaseSecs) } catch {}
  })
  ipcMain.on('engine:clearSync', (_e, deckId: string) => { try { getDeck(deckId).clearSync() } catch {} })
  ipcMain.handle('engine:isSynced', (_e, deckId: string) => {
    try { return getDeck(deckId).isSynced() } catch { return false }
  })

  // ── Loop ──────────────────────────────────────────────────────────────────
  ipcMain.on('engine:setLoop',   (_e, deckId: string, startMs: number, endMs: number) => { try { getDeck(deckId).setLoop(startMs, endMs) } catch {} })
  ipcMain.on('engine:clearLoop', (_e, deckId: string) => { try { getDeck(deckId).clearLoop() } catch {} })

  // ── Output ────────────────────────────────────────────────────────────────
  ipcMain.handle('engine:setOutputDevice', async (_e, deckId: string, deviceId: string) => {
    await getDeck(deckId).setOutputDevice(deviceId)
  })

  // ── Master-bus recording ──────────────────────────────────────────────────
  ipcMain.handle('engine:recordStart', () => {
    if (!addon) throw new Error('Native engine not loaded')
    const dir = path.join(app.getPath('music'), 'Offcut Recordings')
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
    const file = path.join(dir, `mix-${ts}.wav`)
    const err = addon.startRecording(file)
    if (err instanceof Error) throw err
    return file
  })

  ipcMain.handle('engine:recordStop', () => {
    if (!addon) throw new Error('Native engine not loaded')
    const result = addon.stopRecording()
    if (result instanceof Error) throw result
    // Surface the file straight away — recording is a deliverable.
    shell.showItemInFolder(result.path)
    return result
  })

  // ── Getters (sync invoke) ─────────────────────────────────────────────────
  ipcMain.handle('engine:getTime',  (_e, deckId: string) => {
    try { return getDeck(deckId).getTimeMs() / 1000 } catch { return 0 }
  })
  ipcMain.handle('engine:getLevel', (_e, deckId: string) => {
    try { return getDeck(deckId).getLevel() } catch { return 0 }
  })
}
