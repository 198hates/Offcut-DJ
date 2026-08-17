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
# Read productName from the JS config (not just package.json — electron-builder.cjs
# is the source of truth and can differ, e.g. the "Offcut Dark" fork). electron-builder
# keeps spaces as-is in both the .app bundle name and the artifact filename.
PRODUCT_NAME=$(node -p "require('./electron-builder.cjs').productName")

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
APP="dist/mac/$PRODUCT_NAME.app"
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
check "$APP/Contents/MacOS/$PRODUCT_NAME" "electron binary"
check "$RES/crate-audio-engine.node" "rust audio engine"
check "$RES/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" "ffmpeg"
check "$(ls "$RES"/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/build/Release/*.node 2>/dev/null | head -1)" "sqlcipher"

if [ "$fail" != 0 ]; then
  echo "✗ One or more binaries are NOT x86_64 — refusing to ship this DMG."
  exit 1
fi

echo "✓ All native binaries are x86_64."

# The updater zip is what electron-updater actually installs on macOS (it never
# updates from a dmg). Shipping the dmg alone is exactly why Intel users could
# not auto-update at all.
DMG="dist/$PRODUCT_NAME-$VERSION-mac-x64.dmg"
ZIP="dist/$PRODUCT_NAME-$VERSION-x64-mac.zip"
if [ ! -e "$ZIP" ]; then
  echo "✗ Updater zip missing: $ZIP"
  echo "  Expected from the mac 'zip' target + the mac.artifactName pattern in electron-builder.cjs."
  echo "  Present in dist/:"; ls dist/*.zip 2>/dev/null || echo "    (no zips at all)"
  exit 1
fi
case "$ZIP" in
  *arm64*) echo "✗ x64 zip name contains 'arm64' — electron-updater would serve it to Apple Silicon."; exit 1 ;;
esac

echo
echo "==> Merging x64 entries into the published latest-mac.yml…"
# CI publishes an arm64-only manifest; without this merge the x64 assets are
# invisible to electron-updater and Intel stays frozen on its installed build.
WORK=$(mktemp -d)
if ! gh release download "v$VERSION" --repo 198hates/Offcut-DJ \
      --pattern latest-mac.yml --dir "$WORK" --clobber; then
  echo "✗ Could not download latest-mac.yml from release v$VERSION."
  echo "  Push the tag and let CI publish the arm64 build FIRST, then re-run this script."
  exit 1
fi

node scripts/merge-latest-mac-yml.js \
  --base "$WORK/latest-mac.yml" \
  --add  dist/latest-mac.yml \
  --out  "$WORK/merged-latest-mac.yml"

cp "$WORK/merged-latest-mac.yml" dist/latest-mac.yml

echo
echo "✓ Intel build ready. Upload it with:"
echo
echo "  gh release upload v$VERSION \\"
echo "    \"$DMG\" \"$DMG.blockmap\" \\"
echo "    \"$ZIP\" \"$ZIP.blockmap\" \\"
echo "    dist/latest-mac.yml --clobber"
echo
echo "  (latest-mac.yml MUST be uploaded last-ish and with --clobber: it is the"
echo "   merged arm64+x64 manifest that makes Intel auto-update work at all.)"
