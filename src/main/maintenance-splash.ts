/**
 * A small window shown only while one-time library maintenance runs.
 *
 * Why it exists: that maintenance is synchronous SQLite work — measured at ~95s
 * on a real 821MB library on the first launch after upgrading. The main process
 * is blocked solid for the duration, so the app previously showed nothing at all
 * and looked hung. (That is the same "blank window" complaint that started this
 * whole investigation, just from a different cause.)
 *
 * Two consequences of main being blocked shape the design:
 *
 *  - Everything is inlined into a data: URL and loaded BEFORE the work starts.
 *    Nothing can be fetched or computed mid-run.
 *  - The animation is pure CSS. A renderer process keeps painting while main is
 *    stuck, but anything driven by main-process ticks would freeze — so the
 *    spinner must not depend on main being alive.
 *
 * Phase labels are pushed between phases (the only moments main is free), via
 * executeJavaScript rather than IPC so the splash needs no preload script.
 */
import { BrowserWindow } from 'electron'
import type { MaintenancePhase } from './library/db'

const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #F2EEE4; color: #2A2622;
    font: 13px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-app-region: drag;
  }
  @media (prefers-color-scheme: dark) { body { background: #1C1A18; color: #E8E2D6; } }
  .box { text-align: center; padding: 0 28px; }
  .title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
  .label { margin-top: 6px; opacity: .72; font-variant-numeric: tabular-nums; }
  .note  { margin-top: 14px; font-size: 11px; opacity: .5; }
  .track { margin: 16px auto 0; width: 220px; height: 3px; border-radius: 3px;
           background: currentColor; opacity: .16; overflow: hidden; }
  .bar {
    height: 100%; width: 38%; border-radius: 3px; background: #C9A02C;
    /* CSS-driven: main is blocked, so nothing here can rely on it ticking. */
    animation: slide 1.25s ease-in-out infinite;
  }
  @keyframes slide {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(320%); }
  }
</style>
<div class="box">
  <div class="title">Optimising your library</div>
  <div class="label" id="label">Starting…</div>
  <div class="track"><div class="bar"></div></div>
  <div class="note">One-time — this won't happen on the next launch.</div>
</div>`

let splash: BrowserWindow | null = null
let shown = false

/**
 * Create the window up front but keep it hidden: most launches have no
 * maintenance to do, and a splash that flashes for 20ms is worse than none.
 * It reveals itself on the first reported phase.
 */
export async function prepareMaintenanceSplash(): Promise<void> {
  splash = new BrowserWindow({
    width: 380, height: 190, show: false, frame: false, resizable: false,
    movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, title: 'Offcut',
    // Float it: show() alone only makes the window visible, not frontmost, so it
    // can sit silently behind whatever else is open — which is indistinguishable
    // from the hung app this exists to prevent. Verified: without this it landed
    // behind other windows. It's transient and torn down in a finally block.
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  splash.setMenu?.(null)
  const ready = new Promise<void>((resolve) => splash?.webContents.once('did-finish-load', () => resolve()))
  await splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
  // Must be fully loaded before the blocking work begins — there is no chance
  // to finish loading once the main process stops servicing anything.
  await ready
}

/** Show (first call) and update the splash. Safe to call when there's no window. */
export function reportMaintenancePhase(phase: MaintenancePhase): void {
  if (!splash || splash.isDestroyed()) return
  if (phase.id === 'done') return
  if (!shown) {
    splash.show()
    splash.moveTop()
    shown = true
    console.info('[maintenance] running one-time library maintenance')
  }
  const label = JSON.stringify(phase.label)
  void splash.webContents
    .executeJavaScript(`document.getElementById('label').textContent = ${label}`)
    .catch(() => { /* cosmetic only */ })
}

/** Tear down. No-op if it was never shown. */
export function closeMaintenanceSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy()
  splash = null
  shown = false
}

/** Did any maintenance actually run? Used to decide whether to log the launch. */
export function maintenanceWasShown(): boolean {
  return shown
}
