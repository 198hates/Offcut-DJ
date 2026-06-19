#!/usr/bin/env bash
# Driver for Offcut Mobile — the Expo / React Native companion app — running as a
# dev client on an Android emulator, driven via adb. This is the agent harness:
# build/install once, then `metro` + `reload` + `shot` + `errors` to drive & observe.
#
# Subcommands:
#   doctor    — print emulator / Metro / app / disk state
#   emulator  — boot the first AVD if none is running (waits for boot)
#   metro     — ensure Metro (expo start --dev-client) is running (backgrounded)
#   build     — npx expo run:android: compile + install the dev client (one-time, slow)
#   bundle    — fetch the JS bundle from Metro and assert it compiles
#   reload    — force-stop + relaunch the app (the reliable white-screen fix)
#   shot [f]  — screencap the emulator to a PNG (default /tmp/offcut-mobile-<ts>.png)
#   errors    — dump recent JS errors from logcat (system noise filtered out)
#   smoke     — metro → bundle → reload → screenshot → error-scan (end-to-end check)
set -u

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$SKILL_DIR/../../.." && pwd)"   # …/apps/mobile

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin"
ADB="$ANDROID_HOME/platform-tools/adb"
EMU="$ANDROID_HOME/emulator/emulator"
PKG="co.betweenthebridges.offcut.mobile"
METRO_LOG="/tmp/offcut-mobile-metro.log"

metro_up() { lsof -nP -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; }
have_emu() { "$ADB" devices 2>/dev/null | grep -q "emulator-.*device$"; }

cmd_doctor() {
  echo "APP        : $APP"
  echo "adb        : $("$ADB" version 2>/dev/null | head -1)"
  echo "java       : $(java -version 2>&1 | head -1)"
  echo "emulator   : $("$ADB" devices 2>/dev/null | grep emulator || echo none)"
  echo "Metro 8081 : $(metro_up && echo UP || echo down)"
  echo "app pid    : $("$ADB" shell pidof "$PKG" 2>/dev/null | tr -d '\r' || true)"
  echo "disk free  : $(df -h "$HOME" | awk 'NR==2{print $4" ("$5" used)"}')"
}

cmd_emulator() {
  have_emu && { echo "emulator already running"; return 0; }
  local avd; avd="$("$EMU" -list-avds 2>/dev/null | head -1)"
  [ -z "$avd" ] && { echo "no AVD — create one in Android Studio › Device Manager (API 35, arm64)"; exit 1; }
  echo "booting AVD: $avd"
  nohup "$EMU" -avd "$avd" >/tmp/offcut-emulator.log 2>&1 &
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  echo "emulator booted"
}

cmd_metro() {
  metro_up && { echo "Metro already up"; return 0; }
  echo "starting Metro (expo start --dev-client)…"
  ( cd "$APP" && nohup npx expo start --dev-client >"$METRO_LOG" 2>&1 & )
  for _ in $(seq 1 40); do metro_up && { echo "Metro up"; return 0; }; sleep 2; done
  echo "Metro failed to start — see $METRO_LOG"; exit 1
}

cmd_build() {
  cmd_emulator
  echo "compiling + installing the dev client (npx expo run:android) — first build is slow…"
  ( cd "$APP" && npx expo run:android )
}

cmd_bundle() {
  metro_up || cmd_metro
  local out=/tmp/offcut-bundle.out code size
  code=$(curl -s --max-time 180 -o "$out" -w "%{http_code}" "http://localhost:8081/index.bundle?platform=android&dev=true")
  size=$(wc -c <"$out" | tr -d ' ')
  echo "bundle: HTTP $code, $size bytes"
  if head -c 200 "$out" | grep -q "__BUNDLE_START_TIME__\|var __"; then echo "bundle JS ✓"; else echo "BUNDLE ERROR:"; head -c 800 "$out"; exit 1; fi
}

cmd_reload() {
  have_emu || { echo "no emulator"; exit 1; }
  "$ADB" shell am force-stop "$PKG" 2>/dev/null
  "$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  echo "relaunched $PKG (cold start — pulls a fresh bundle)"
}

cmd_shot() {
  have_emu || { echo "no emulator"; exit 1; }
  local f="${1:-/tmp/offcut-mobile-$(date +%s).png}"
  "$ADB" exec-out screencap -p >"$f"
  echo "screenshot: $f ($(wc -c <"$f" | tr -d ' ') bytes) — open it to confirm the UI rendered"
}

cmd_errors() {
  have_emu || { echo "no emulator"; exit 1; }
  "$ADB" logcat -d -t 600 2>/dev/null \
    | grep -iE "ReactNativeJS|ExceptionsManager|redbox|FATAL EXCEPTION" \
    | grep -ivE "Binder|ConnectivityService|NullBinder|googlequicksearchbox" \
    | tail -40
  echo "(empty above = no JS errors logged)"
}

cmd_smoke() {
  cmd_metro
  cmd_bundle
  cmd_reload
  echo "waiting for the app to paint…"; sleep 7
  cmd_shot /tmp/offcut-mobile-smoke.png
  echo "--- JS errors (should be empty) ---"; cmd_errors
}

case "${1:-smoke}" in
  doctor) cmd_doctor;;
  emulator) cmd_emulator;;
  metro) cmd_metro;;
  build) cmd_build;;
  bundle) cmd_bundle;;
  reload) cmd_reload;;
  shot) shift || true; cmd_shot "${1:-}";;
  errors) cmd_errors;;
  smoke) cmd_smoke;;
  *) echo "usage: driver.sh {doctor|emulator|metro|build|bundle|reload|shot [file]|errors|smoke}"; exit 1;;
esac
