---
name: run-offcut-mobile
description: Build, launch, screenshot, and drive the Offcut Mobile app (Expo / React Native companion) on an Android emulator. Use when asked to run, start, build, launch, screenshot, reload, or smoke-test the mobile / phone app, or debug why it shows a white screen / "unable to show script error".
---

# Run Offcut Mobile

`apps/mobile` is the Expo / React Native companion to the desktop Offcut library
manager. It pairs to the desktop over the LAN, mirrors the library offline, and
auditions a streamed/cached AAC proxy per track. It uses **native modules**
(`@shopify/react-native-skia`, `react-native-reanimated`, `expo-audio`,
`expo-camera`), so it runs as a **dev client** (not Expo Go) on an Android
emulator and is driven via **`adb`** through the harness:
**`.claude/skills/run-offcut-mobile/driver.sh`**.

> Verified on **macOS (Apple Silicon)**, targeting the Android emulator. Paths
> below are relative to `apps/mobile/`. Not verified on Linux.

## Prerequisites
- **Node** + the repo on a **local disk path** (e.g. `~/dev/DJ`) — NOT OneDrive/
  CloudStorage (see Gotchas; Gradle can't hash files there and the build fails).
- **Android Studio** (provides the SDK, the emulator, and a bundled JDK). One-time:
  ```bash
  brew install --cask android-studio   # if not already installed
  brew install watchman
  ```
  Then in Android Studio: run the SDK setup wizard, install **Android 15 / API 35
  (arm64)**, and create an AVD (Device Manager → Pixel 8 → API 35 arm64).
- **Shell env** (in `~/.zshrc`), so the CLI + Gradle find the SDK and JDK:
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin
  ```
  (The driver also exports these itself, so it works without a configured shell.)

## Build (one-time — installs the dev client onto the emulator)
```bash
cd apps/mobile
npm install
bash .claude/skills/run-offcut-mobile/driver.sh build   # = boots an AVD + `npx expo run:android`
```
The first build is slow (compiles Skia/reanimated C++; ~10–20 min cold, ~30–60s
warm). It installs the `co.betweenthebridges.offcut.mobile` dev client and leaves
Metro running. `app.json` already enables Android cleartext HTTP (required — see
Gotchas) and links the EAS project.

## Run (agent path — use this)
The driver wraps Metro + `adb`. From `apps/mobile`:
```bash
D=.claude/skills/run-offcut-mobile/driver.sh
bash $D doctor    # emulator / Metro / app pid / disk state
bash $D metro     # ensure Metro (expo start --dev-client) is up (backgrounded)
bash $D bundle    # fetch the JS bundle from Metro and assert it compiles
bash $D reload    # force-stop + relaunch the app  ← the white-screen fix
bash $D shot      # screencap the emulator → /tmp/offcut-mobile-<ts>.png
bash $D errors    # recent JS errors from logcat (system noise filtered out)
bash $D smoke     # metro → bundle → reload → screenshot → error-scan, end to end
```
`shot` writes a PNG to `/tmp` — **open it** to confirm the UI rendered. `smoke` is
the one-shot "is it alive" check. JS edits hot-reload (no rebuild); only new native
deps need `build` again.

## Pair the emulator with the desktop
The app needs the desktop Offcut's **Phone Sync** server running (its own page,
above USB). The emulator has **no camera**, so skip the QR and use the manual
field with the emulator→host alias **`10.0.2.2`** (the QR's LAN IP is unreachable
from the AVD):
```
10.0.2.2:47823 <token>
```
Token + port are in the desktop pairing store: `~/Library/Application Support/offcut/phone-sync.json`.

## Run (human path)
```bash
cd apps/mobile && npx expo start --dev-client   # press a, or open the Offcut dev app
```
Useless without the emulator + a prior `build`.

## Test
```bash
cd apps/mobile && npx tsc --noEmit               # typecheck
# The smart-rule evaluator is unit-tested from the desktop suite:
# (repo root) npx vitest run src/main/library/__tests__/smart-rules-mobile.test.ts
```

## Gotchas (the battle scars)
- **Repo must be on a local path, not OneDrive/CloudStorage.** `npx expo run:android`
  fails at `:shopify_react-native-skia:prepareHeaders` with *"Failed to create MD5
  hash … JsiSkTextBlob.h"* — Gradle can't reliably read cloud-backed files. (Same
  cause as flaky Metro/electron-vite reloads.) Fix: work in `~/dev/DJ`.
- **Skia v2 needs `react-native-reanimated`** (+ its `react-native-worklets` peer)
  or it throws `OptionalDependencyNotInstalledError: react-native-reanimated is not
  installed` (red screen) at startup. Both are installed; `babel-preset-expo`
  auto-wires the worklets plugin.
- **Android blocks cleartext HTTP by default.** The app talks to the desktop over
  `http://<host>` — a standalone build silently fails to connect without
  `expo-build-properties` → `android.usesCleartextTraffic: true` in `app.json`
  (already set). Expo Go masks this, so it "works in dev, breaks in the build."
- **White screen after Metro restarts** = the dev client is holding a stale bundle.
  A plain Cmd+M → Reload keeps loading the broken one; **`driver.sh reload`
  (force-stop + relaunch)** pulls a fresh bundle. This is the reliable fix.
- **"Unable to show script error"** = Metro is down (the dev client can't fetch/
  symbolicate JS). Run `driver.sh metro`.
- **@types/react 19 removed the global `JSX` namespace** → `JSX.Element`
  annotations fail tsc on a clean install. `global.d.ts` re-exposes it.
- **`▶`/`❚❚` unicode render as colour-emoji on Android** (a teal halo on the play
  button) — drawn as shapes (triangle / bars) instead.
- **JetBrains Mono** is loaded via `@expo-google-fonts/jetbrains-mono` (Expo Go
  compatible); first paint is gated on the font.
- **Disk pressure.** Native builds + `~/.gradle` (~3.4 GB) + `node_modules` (~1.1 GB)
  are heavy; a starved host renders the emulator white and logs binder
  `No space left on device`. Keep headroom (`driver.sh doctor` prints free space).

## Troubleshooting
| Symptom | Fix |
|---|---|
| `prepareHeaders` MD5-hash failure | Move the repo off OneDrive to `~/dev/DJ`, reinstall, rebuild |
| `react-native-reanimated is not installed` red screen | `npx expo install react-native-reanimated react-native-worklets`, then `driver.sh build` |
| White screen, no error | `driver.sh reload` (cold restart); if persists, `driver.sh errors` + check `/tmp/offcut-mobile-metro.log` |
| "unable to show script error" | `driver.sh metro` (Metro was down) |
| App builds but can't reach desktop | confirm `usesCleartextTraffic` in `app.json`; pair via `10.0.2.2:47823`, not the LAN IP, on the emulator |
| `JSX` namespace tsc errors | ensure `apps/mobile/global.d.ts` exists |
