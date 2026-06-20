# Packaging Offcut

Installers are built on **native CI runners** (the only reliable way to get
correct native binaries — the Rust engine, SQLCipher, ONNX, ffmpeg — per
OS/arch). See `.github/workflows/release.yml`.

## Build installers

| Trigger | Result |
|---|---|
| Push a `v*` tag (`git tag v0.1.1 && git push origin v0.1.1`) | Builds Mac arm64 + Mac Intel + Windows x64, **publishes to GitHub Releases** |
| Actions → *Build & Release* → Run workflow | Same builds, installers attached as **run artifacts** (no release) |

Locally you can build the host arch only: `npm run build:mac` (arm64),
`npm run build:mac:x64` (Intel — needs an Intel Mac), `npm run build:win` (on Windows).

## Signing (currently OFF)

Builds are **unsigned**. Users must:
- **macOS** — right-click → Open the first launch (or `xattr -dr com.apple.quarantine /Applications/Offcut.app`).
- **Windows** — SmartScreen → More info → Run anyway.

To sign later: set `mac.identity` + notarization creds and a Windows cert in
`electron-builder.cjs` / CI secrets.

## Optional bundled assets

The packager (`electron-builder.cjs`) includes these **only if present**, so a
lean build never fails when they're absent.

### Beat-detection model — `build/models/beat_this.onnx` (tracked in Git LFS)

Small, platform-independent, improves beat detection (the renderer JS tracker is
the fallback). One-time:

```bash
pip install beat_this torch torchaudio onnx
python scripts/export-beat-this.py --output build/models/beat_this.onnx
git add build/models/beat_this.onnx   # LFS filter handles it (see .gitattributes)
git commit
```

CI checks out LFS (`lfs: true`) and bundles it automatically.

### Demucs stem-separation pack (~600 MB) — on-demand download, NOT bundled

Bundling ×3 platforms would bloat every installer, so we ship lean: stems fall
back to the user's system Python (`pip install demucs soundfile`), and the app
offers a one-click download of a self-contained pack (Settings → Stems → *Stem
engine pack*). Mechanism lives in `src/main/stems/installer.ts`.

To enable the download you must build + host the packs once:

1. **Build a PyInstaller bundle per platform** (on each native OS), producing a
   folder `offcut-demucs/` containing the `offcut-demucs` binary (`.exe` on
   Windows) plus a `torch-home/` with the htdemucs weights.
2. **Archive** each as `.tar.gz` with that folder at the root:
   ```
   tar -czf offcut-demucs-mac-arm64.tar.gz offcut-demucs/
   # → offcut-demucs-mac-x64.tar.gz, offcut-demucs-win-x64.tar.gz
   ```
3. **Host** the three archives as assets on a GitHub Release tagged
   `stems-pack-v1` (matches `DEFAULT_PACK_BASE` in `installer.ts`). Point
   elsewhere without rebuilding via the `OFFCUT_STEMS_PACK_BASE` env var.

Until the packs are published, the in-app installer surfaces a clear "is the
pack published yet?" error and stems still work via system Python.

## Pre-release checklist

- [ ] Rotate the licence `SECRET` in `src/main/licence.ts` **and**
      `scripts/mint-licence.mjs` (must match), then mint real keys — invalidates
      the `TEST` / `GATE-TEST` keys.
- [ ] Remove the test key activated on the dev machine; reset
      `showWelcomeOnStartup`.
- [ ] Bump `version` in `package.json` before tagging.
