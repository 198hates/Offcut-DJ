---
name: run-offcut
description: Build, launch, and smoke-test the Offcut desktop DJ library app (Electron + Vite + Rust audio engine + SQLCipher). Use when asked to run, start, build, launch, or verify the desktop app, the main app, or its Phone Sync server.
---

# Run Offcut (desktop)

Offcut is an Electron + React/Vite desktop DJ library manager with a **Rust
native audio engine** (`napi` → `crate-audio-engine.node`) and an **encrypted
SQLCipher** library. The GUI is a full DJ app; the reliable *programmatic*
surface is the **Phone Sync HTTP server** the Electron main process exposes
(hitting it proves the app booted, the native engine loaded, and the encrypted
library opened) — that's the server the mobile companion talks to. Driven via
**`.claude/skills/run-offcut/driver.sh`**.

> Verified on **macOS (Apple Silicon)**. Paths are relative to the repo root.
> The GUI itself can't be pixel-captured headless (see `shot` / Gotchas).

## Prerequisites
- **Node**, and the repo on a **local disk path** (`~/dev/DJ`) — NOT OneDrive/
  CloudStorage (the electron-vite watcher and native file hashing misbehave there).
- **Rust** (`rustup`; `cargo` on `PATH`) — builds the audio engine.
- **Xcode Command Line Tools** — the C/C++ toolchain for the Rust engine and the
  `node-gyp` rebuild of `better-sqlite3-multiple-ciphers`.

## Build (one-time — native bits aren't committed)
```bash
bash .claude/skills/run-offcut/driver.sh build
# = npm install  &&  npm run engine:build  (cargo --release + copy .node)  &&  npm run rebuild:sqlcipher
```
`engine:build` compiles the Rust engine to `native/audio-engine/crate-audio-engine.node`
(gitignored, so a fresh clone must build it; ~20s warm). `rebuild:sqlcipher`
rebuilds `better-sqlite3-multiple-ciphers` against the app's Electron ABI (needed
to open the encrypted library / Rekordbox 7 DBs).

## Run (agent path — use this)
```bash
D=.claude/skills/run-offcut/driver.sh
bash $D doctor    # build artifacts + server/renderer/health/cargo state
bash $D dev       # launch `npm run dev`; waits for the server + "NativeEngine loaded"
bash $D health    # curl the open /health endpoint
bash $D renderer  # assert the Vite renderer (5173) serves HTML
bash $D api       # /sync/pull → prints "library: N tracks, M playlists" (proves SQLCipher opened)
bash $D smoke     # dev → health → renderer → api → boot-log, end to end
```
`api` reads the Phone Sync token from `~/Library/Application Support/offcut/phone-sync.json`
and requires Phone Sync to be **enabled** in the app (Settings/PhoneSync page). The
dev log is `/tmp/offcut-desktop-dev.log`.

## Run (human path)
```bash
npm run dev      # electron-vite: Electron window opens; Ctrl-C to stop
```
Renderer dev server on `localhost:5173`, Phone Sync server on `127.0.0.1:47823`.

## GUI screenshot
```bash
bash .claude/skills/run-offcut/driver.sh shot
```
Best-effort **full-display** capture via macOS `screencapture` — it grabs
whatever's frontmost, so **focus the Offcut window first** (multiple Electron
apps can't be disambiguated by process name). **Requires Screen Recording
permission** for your terminal (System Settings › Privacy & Security); without it
it errors "could not create image from display." The GUI can't be captured
headless — the real verification is `smoke` (HTTP + boot log), not a pixel grab.

## Test
```bash
npx vitest run                       # full suite (268 tests as of this writing)
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
```

## Gotchas
- **Repo must be on a local path, not OneDrive.** The electron-vite watcher
  silently fails to rebuild the main process on save there (you'll run stale
  code), file reads are slow, and a flood of phantom HMR reloads can crash the
  renderer. Work in `~/dev/DJ`.
- **The native engine `.node` is gitignored** — a fresh clone has no audio engine
  until `npm run engine:build`. If the app boots but logs no `[NativeEngine] loaded`,
  you skipped the engine build.
- **SQLCipher rebuild is mandatory** for the encrypted library — `npm install`
  alone leaves `better-sqlite3-multiple-ciphers` built for the wrong ABI; run
  `npm run rebuild:sqlcipher` (the `build` subcommand does it).
- **Phone Sync is opt-in.** `/health` answers whenever the server's enabled; if
  `47823` is down, enable Phone Sync in the app. `api`/`smoke` need it on.
- **Don't run two instances** (e.g. an old OneDrive copy + the local one) — they
  both bind `47823` and clash.
- **A heavy sync op used to block the main-process event loop** (froze `/health`
  and the renderer); the phone pull is now metadata-only + the content-hash
  backfill is async/off the request path. If `/health` hangs for seconds, look for
  a synchronous loop over the library on the main thread.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `doctor` shows engine `.node` MISSING | `npm run engine:build` (needs `cargo`) |
| App boots, no `NativeEngine] loaded` | engine `.node` absent/incompatible → rebuild it |
| Library won't open / SQLCipher errors | `npm run rebuild:sqlcipher` (Electron ABI mismatch) |
| `/health` no response | enable Phone Sync in the app; ensure only one instance is running |
| `api` says "no pairing token" | enable Phone Sync once (it writes `phone-sync.json`) |
| `screencapture` "could not create image" | grant Screen Recording to the terminal, or skip GUI capture |
| stale code after edits | you're on OneDrive — move to `~/dev/DJ` |
