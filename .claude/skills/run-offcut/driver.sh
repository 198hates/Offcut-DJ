#!/usr/bin/env bash
# Driver for Offcut — the desktop DJ library manager (Electron + Vite + a Rust
# native audio engine + SQLCipher library). The GUI is a full DJ app; the
# reliable PROGRAMMATIC surface is the Phone Sync HTTP server served by the
# Electron main process — hitting it proves the app booted, the native engine
# loaded, and the (encrypted) library opened. That's the server the mobile
# companion talks to.
#
# Subcommands:
#   doctor    — build artifacts + server/renderer/health state
#   build     — npm install + engine:build (Rust) + rebuild:sqlcipher (one-time, slow)
#   dev       — launch `npm run dev` (electron-vite), wait for server + native engine
#   health    — curl the open /health endpoint
#   renderer  — assert the Vite renderer (5173) serves HTML
#   api       — pull the library over /sync/pull (proves SQLCipher opened); prints counts
#   shot [f]  — best-effort macOS window screenshot (needs Screen Recording permission)
#   smoke     — dev → health → renderer → api → boot-log (end-to-end boot check)
set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$SKILL_DIR/../../.." && pwd)"   # repo root (.claude/skills/run-offcut → up 3)
export PATH="$HOME/.cargo/bin:$PATH"    # cargo, for engine:build
PORT=47823
# userData dir = package.json "name" (electron's default app.getName()) — this repo
# may be a fork (e.g. offcut-dark) with its own userData dir distinct from "offcut".
APP_NAME="$(node -pe "require('$APP/package.json').name" 2>/dev/null || echo offcut)"
PS="$HOME/Library/Application Support/$APP_NAME/phone-sync.json"
DEV_LOG="/tmp/offcut-desktop-dev-$APP_NAME.log"
PULL_JSON="/tmp/offcut-pull-$APP_NAME.json"

server_up()   { lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; }
renderer_up() { lsof -nP -iTCP:5173 -sTCP:LISTEN  >/dev/null 2>&1; }
token()       { node -e "try{process.stdout.write(require('$PS').token||'')}catch(e){}" 2>/dev/null; }

cmd_doctor() {
  echo "APP            : $APP"
  echo "engine .node   : $(ls "$APP/native/audio-engine/crate-audio-engine.node" >/dev/null 2>&1 && echo present || echo 'MISSING — run: driver.sh build')"
  echo "node_modules   : $([ -d "$APP/node_modules" ] && echo yes || echo 'NO — run: npm install')"
  echo "cargo          : $(command -v cargo >/dev/null && cargo --version || echo 'MISSING (rustup)')"
  echo "PhoneSync 47823: $(server_up && echo UP || echo down)"
  echo "renderer 5173  : $(renderer_up && echo UP || echo down)"
  echo "/health        : $(curl -s --max-time 4 http://127.0.0.1:$PORT/health 2>/dev/null || echo 'no response')"
}

cmd_build() {
  ( cd "$APP" && npm install && npm run engine:build && npm run rebuild:sqlcipher )
}

cmd_dev() {
  server_up && { echo "already running"; return 0; }
  echo "launching npm run dev (electron-vite)…"
  ( cd "$APP" && nohup npm run dev >"$DEV_LOG" 2>&1 & )
  for _ in $(seq 1 60); do
    if server_up && grep -q "NativeEngine] loaded" "$DEV_LOG" 2>/dev/null; then echo "up (Phone Sync server + native engine loaded)"; return 0; fi
    sleep 2
  done
  echo "did not come up — last log lines:"; tail -20 "$DEV_LOG" 2>/dev/null; exit 1
}

cmd_health() {
  curl -s --max-time 6 http://127.0.0.1:$PORT/health -w "\n[%{http_code}]\n" \
    || { echo "no response — is Phone Sync enabled in the app + dev running?"; exit 1; }
}

cmd_renderer() {
  curl -s --max-time 6 http://localhost:5173 | grep -qiE "<div id=\"?root|<!doctype html|<title" \
    && echo "renderer serving HTML ✓" || { echo "renderer (5173) not serving"; exit 1; }
}

cmd_api() {
  local t; t="$(token)"
  [ -z "$t" ] && { echo "no pairing token in $PS — enable Phone Sync once in the app, then retry"; return 0; }
  curl -s --max-time 30 -H "Authorization: Bearer $t" "http://127.0.0.1:$PORT/sync/pull?cursor=0" \
    -o "$PULL_JSON" -w "pull [%{http_code}] %{size_download} bytes\n"
  node -e "const d=require('$PULL_JSON');console.log('library:',d.tracks.length,'tracks,',d.playlists.length,'playlists')" 2>/dev/null || true
}

cmd_shot() {
  local f="${1:-/tmp/offcut-desktop-$(date +%s).png}"
  if screencapture -x -o "$f" 2>/tmp/offcut-sc.err && [ -s "$f" ]; then
    echo "screenshot (full display): $f"
  else
    echo "screencapture failed: $(cat /tmp/offcut-sc.err 2>/dev/null)"
    echo "→ grant Screen Recording to your terminal in System Settings › Privacy & Security, or just look at the window. The GUI can't be captured headless."
  fi
}

cmd_smoke() {
  cmd_dev
  echo "--- health ---";   cmd_health
  echo "--- renderer ---"; cmd_renderer
  echo "--- library ---";  cmd_api
  echo "--- boot log ---"; grep -E "NativeEngine|built successfully|renderer process" "$DEV_LOG" 2>/dev/null | tail -6
}

case "${1:-smoke}" in
  doctor) cmd_doctor;;
  build) cmd_build;;
  dev) cmd_dev;;
  health) cmd_health;;
  renderer) cmd_renderer;;
  api) cmd_api;;
  shot) shift || true; cmd_shot "${1:-}";;
  smoke) cmd_smoke;;
  *) echo "usage: driver.sh {doctor|build|dev|health|renderer|api|shot|smoke}"; exit 1;;
esac
