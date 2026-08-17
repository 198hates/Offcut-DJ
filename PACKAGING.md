# Packaging Offcut

Installers are built on **native CI runners** (the only reliable way to get
correct native binaries — the Rust engine, SQLCipher, ONNX, ffmpeg — per
OS/arch). See `.github/workflows/release.yml`.

## Build installers

| Trigger | Result |
|---|---|
| Push a `v*` tag (`git tag v0.1.2 && git push origin v0.1.2`) | Builds **Mac arm64 + Windows x64** on CI, **publishes to GitHub Releases** |
| Actions → *Build & Release* → Run workflow | Same builds, installers attached as **run artifacts** (no release) |

Locally you can build the host arch: `npm run build:mac` (arm64),
`npm run build:win` (on Windows).

### Intel macOS — cross-built from Apple Silicon

GitHub's hosted Intel runners (`macos-13`) no longer schedule, so Intel isn't on
CI. A plain `electron-builder --x64` on an arm64 host silently bundles host-arch
binaries (arm64 ffmpeg, etc.). Use the dedicated script instead — it cross-builds
the Rust engine, fetches the correct x64 ffmpeg, packages, and **verifies every
bundled binary is x86_64 before succeeding** (and restores your arm64 toolchain
after):

```bash
bash scripts/build-mac-x64.sh        # → dist/Offcut-<ver>-mac-x64.dmg (verified x86_64)
```

**Order matters: push the tag and let CI publish the arm64 release FIRST, then
run this script.** It downloads the release's `latest-mac.yml` and merges the x64
entries into it — so it needs the arm64 manifest to already be there. The script
hard-fails with instructions if it isn't.

Note: `onnxruntime-node` has no Intel-macOS binary (Microsoft dropped it), so
onnxruntime is loaded lazily and ONNX beat-analysis is unavailable on Intel (the
JS beat tracker is the fallback). The script ends with the exact `gh release
upload` command for the Intel assets.

### Why the Intel upload includes a zip and latest-mac.yml

Both are load-bearing for auto-update, and omitting them is why **every Intel
user was silently frozen on whatever DMG they hand-installed** (they hit a
fixed-in-v1.0.7 Rekordbox sync bug for weeks because the fix could never reach
them):

- **electron-updater never updates macOS from a `.dmg` — only from a `.zip`.**
  The Intel build previously shipped a DMG alone.
- **`latest-mac.yml` is written per build, and last upload wins.** CI's arm64 run
  and the Intel run each describe only their own arch, so the published manifest
  listed arm64 only. `MacUpdater` then filters candidates by whether the URL
  contains `arm64` — on Intel that filter emptied the list and the update died
  with `ERR_UPDATER_ZIP_FILE_NOT_FOUND`.

`scripts/merge-latest-mac-yml.js` merges both arches into one `files:` list,
which satisfies the filter on both sides. Artifact names are pinned by
`mac.artifactName` in `electron-builder.cjs` so the x64 zip can never
accidentally contain `arm64` (electron-builder otherwise drops the arch from the
*default* arch's filename, yielding a bare `Offcut-<ver>-mac.zip`).

(`npm run build:mac:x64` builds x64 directly only on a *real* Intel Mac; on
Apple Silicon use the script above.)

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
