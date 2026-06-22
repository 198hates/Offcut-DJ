#!/usr/bin/env bash
#
# Build a CORRECT Intel (x86_64) macOS DMG from an Apple Silicon Mac.
#
# Why this exists: GitHub's hosted Intel runners no longer schedule, and a plain
# `electron-builder --x64` on an arm64 host silently ships host-arch native
# binaries (arm64 ffmpeg, etc.) inside the "Intel" app. This script sources the
# correct x64 binaries, cross-builds the Rust engine, packages, and then VERIFIES
# every bundled native binary is x86_64 before declaring success — so it can't
# produce a silently-broken DMG. It restores the arm64 dev toolchain on exit.
#
# onnxruntime-node has no Intel-macOS binary (Microsoft dropped it); the app
# loads onnxruntime lazily, so the Intel build runs fine without it (ONNX beat
# analysis is simply unavailable there — the JS tracker is the fallback). We
# therefore do NOT require an x64 onnxruntime binary.
#
# Usage:  bash scripts/build-mac-x64.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=x86_64-apple-darwin
VERSION=$(node -p "require('./package.json').version")

restore() {
  echo "==> Restoring arm64 dev toolchain…"
  npx electron-builder install-app-deps >/dev/null 2>&1 || true
  rm -f node_modules/ffmpeg-static/ffmpeg node_modules/ffmpeg-static/ffmpeg.{README,LICENSE}
  node node_modules/ffmpeg-static/install.js >/dev/null 2>&1 || true
  npm run engine:build >/dev/null 2>&1 || true
  echo "==> Done (arm64 toolchain restored)."
}
trap restore EXIT

echo "==> Cross-building Rust engine for $TARGET…"
rustup target add "$TARGET" >/dev/null 2>&1 || true
cargo build --release --target "$TARGET" --manifest-path native/audio-engine/Cargo.toml
ENGINE_TARGET="$TARGET" node scripts/copy-engine.js

echo "==> Fetching x64 ffmpeg (delete host binary so install.js re-downloads)…"
rm -f node_modules/ffmpeg-static/ffmpeg node_modules/ffmpeg-static/ffmpeg.{README,LICENSE}
npm_config_arch=x64 npm_config_platform=darwin node node_modules/ffmpeg-static/install.js

echo "==> Building renderer + main…"
npm run build

echo "==> Packaging x64 DMG (electron-builder rebuilds SQLCipher for x64)…"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.cjs --mac --x64 --publish never

echo "==> Verifying every bundled native binary is x86_64…"
APP="dist/mac/Offcut.app"
RES="$APP/Contents/Resources"
fail=0
check() {
  local f="$1" label="$2"
  if [ -z "$f" ] || [ ! -e "$f" ]; then echo "  ??  MISSING  $label"; fail=1; return; fi
  local a; a=$(lipo -archs "$f" 2>/dev/null || file -b "$f")
  case "$a" in
    *x86_64*) echo "  OK  $a  $label" ;;
    *)        echo "  ✗   $a  $label"; fail=1 ;;
  esac
}
check "$APP/Contents/MacOS/Offcut" "electron binary"
check "$RES/crate-audio-engine.node" "rust audio engine"
check "$RES/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" "ffmpeg"
check "$(ls "$RES"/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/build/Release/*.node 2>/dev/null | head -1)" "sqlcipher"

if [ "$fail" != 0 ]; then
  echo "✗ One or more binaries are NOT x86_64 — refusing to ship this DMG."
  exit 1
fi

echo "✓ All native binaries are x86_64."
echo
echo "Built: $(ls dist/Offcut-"$VERSION"-mac-x64.dmg)"
echo "Upload to the release with:"
echo "  gh release upload v$VERSION dist/Offcut-$VERSION-mac-x64.dmg dist/Offcut-$VERSION-mac-x64.dmg.blockmap --clobber"
