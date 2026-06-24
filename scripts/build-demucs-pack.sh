#!/usr/bin/env bash
#
# Build a self-contained Demucs stem-separation pack for the HOST platform —
# the pack Offcut downloads on demand (Settings → Stems → Stem engine pack).
# Freezes `python -m demucs` + PyTorch + the htdemucs model into a standalone
# binary with PyInstaller, so end users need no Python at all.
#
# PyInstaller can't cross-compile, so run this natively on each target:
#   macOS Apple Silicon → mac-arm64   macOS Intel → mac-x64   Windows → win-x64
#
# Requirements (in the active python3):
#   pip install demucs torch torchaudio pyinstaller
#
# Output: build/demucs-pack/offcut-demucs-<key>.tar.gz  (top-level dir
# `offcut-demucs/` containing the binary, _internal/ and torch-home/ — the exact
# layout src/main/stems resolves). Upload it to the `stems-pack-v1` release:
#   gh release upload stems-pack-v1 build/demucs-pack/offcut-demucs-<key>.tar.gz --repo 198hates/Offcut-DJ --clobber
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=build/demucs-pack
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  KEY=mac-arm64 ;;
  Darwin-x86_64) KEY=mac-x64 ;;
  *)             KEY="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)" ;;  # Windows: run via Git Bash, set KEY=win-x64
esac
echo "==> building offcut-demucs pack for: $KEY"

rm -rf "$OUT"; mkdir -p "$OUT/torch-home"

# 1. Pre-fetch htdemucs weights into a torch-home we bundle → fully offline at runtime.
echo "==> pre-fetching htdemucs weights…"
TORCH_HOME="$PWD/$OUT/torch-home" python3 -c "from demucs.pretrained import get_model; get_model('htdemucs')"

# 2. Standalone entrypoint. freeze_support() makes multiprocessing-spawned
#    children re-exec as workers instead of re-running the demucs CLI (which
#    would error on Python's -B -S -I -c flags and exit non-zero post-success).
cat > "$OUT/entry.py" <<'PY'
import multiprocessing
if __name__ == '__main__':
    multiprocessing.freeze_support()
    from demucs.separate import main
    main()
PY

# 3. Freeze. --collect-all numpy + the numpy.core hidden-imports bundle numpy
#    2.x's deprecated `numpy.core` compat shim that the model pickle needs
#    (it's loaded lazily during unpickle, so PyInstaller misses it otherwise).
echo "==> freezing with PyInstaller (several minutes)…"
python3 -m PyInstaller --noconfirm --onedir --name offcut-demucs \
  --collect-all demucs --collect-all torch --collect-all torchaudio \
  --collect-all julius --collect-all dora --collect-all openunmix \
  --collect-all lameenc --collect-all einops --collect-all numpy \
  --hidden-import numpy.core.multiarray --hidden-import numpy.core._multiarray_umath \
  --distpath "$OUT/dist" --workpath "$OUT/work" --specpath "$OUT" \
  "$OUT/entry.py"

# 4. Assemble: the PyInstaller onedir IS the pack root; drop torch-home inside it.
cp -R "$OUT/torch-home" "$OUT/dist/offcut-demucs/torch-home"

# 5. Tar (top-level entry must be `offcut-demucs/`).
tar -czf "$OUT/offcut-demucs-$KEY.tar.gz" -C "$OUT/dist" offcut-demucs
echo "==> built $OUT/offcut-demucs-$KEY.tar.gz ($(du -h "$OUT/offcut-demucs-$KEY.tar.gz" | cut -f1))"
echo "    upload: gh release upload stems-pack-v1 $OUT/offcut-demucs-$KEY.tar.gz --repo 198hates/Offcut-DJ --clobber"
