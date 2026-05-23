# crate-audio-engine

Native real-time audio engine for the Crate DJ app — **id·2026·009**.

Built with Rust + [napi-rs](https://napi.rs/), using:
| Crate | Role |
|---|---|
| `cpal` | Cross-platform audio I/O (CoreAudio / WASAPI / ALSA / ASIO) |
| `symphonia` | Pure-Rust audio decoding (MP3, AAC/M4A, FLAC, WAV, OGG, AIFF…) |
| `rubato` | Sample-rate conversion |
| `arc-swap` | Lock-free PCM buffer swaps in the audio callback |
| `napi` v2 | Node.js N-API bindings |

---

## Prerequisites

```bash
# 1. Install Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# 2. Add the napi-rs CLI
npm install -g @napi-rs/cli

# 3. (macOS only) Ensure Xcode Command Line Tools are installed
xcode-select --install
```

> **ASIO on Windows**: requires the [ASIO SDK](https://www.steinberg.net/asiosdk) and the `cpal/asio`
> feature. See the cpal docs for setup. The ASIO feature is already declared in `Cargo.toml`.

---

## Build (development)

```bash
cd native/audio-engine

# Debug build (fast compile, not optimised)
cargo build

# Release build (optimised, stripped)
cargo build --release
```

The `.node` file is output to `target/debug/` or `target/release/`. The main process loader in
`src/main/engine/index.ts` checks several candidate paths including the debug/release locations.

### Using napi-rs CLI (cross-compilation / CI)

```bash
# Build for the host platform
napi build --platform --release

# Cross-compile for arm64 (Apple Silicon) from x64 host
napi build --platform --target aarch64-apple-darwin --release
```

The napi CLI outputs `crate-audio-engine.{platform}-{arch}.node` in the current directory.

---

## Integration with Electron

The `electron.vite.config.ts` is pre-configured to include the `.node` file in the main process
bundle. `electron-builder` unpacks it from the asar via:

```json
"asarUnpack": ["out/main/crate-audio-engine.node"]
```

The main process loads it at startup via `src/main/engine/index.ts`. If the `.node` file is missing
the engine gracefully falls back to the Web Audio API engine in the renderer — no crash, just a log
message: `[NativeEngine] .node addon not found`.

---

## Architecture

```
Renderer                       Main Process              Rust Native Thread
────────────────────           ────────────────          ──────────────────────
NativeAudioEngine.play()  →    engine:play IPC  →        DeckEngine::is_playing = true
NativeAudioEngine.seek()  →    engine:seek IPC  →        DeckEngine::cursor = ...
NativeAudioEngine.load()  →    engine:load IPC  →        decode_file() [blocking thread]
                                                           ↓
                                                          PcmBuffer swapped in atomically
                                                           ↓
                           ←   engine:timeUpdate   ←     AudioEvent::TimeUpdate pushed
                                                          from cpal callback every ~12 ms
```

### Real-time safety

The cpal audio callback (`output.rs`) is **wait-free**:
- Reads from `DeckEngine` via atomics (`AtomicBool`, `AtomicU32`, `AtomicU64`)
- PCM data accessed via `ArcSwap::load()` (lock-free)
- Events sent via `crossbeam_channel::try_send()` (non-blocking)
- No heap allocation, no mutex, no syscall inside the callback body

---

## Phases

| Phase | Feature | Status |
|---|---|---|
| 1 | Contract + IPC bridge (TypeScript) | ✅ complete |
| 2 | Playback, loop, volume, rate, stems (mock) | 🟡 this crate |
| 3 | Keylock — rubberband-rs time-stretch | 🔲 todo |
| 4 | EQ — biquad filter in callback | 🔲 todo |
| 5 | Stem buses — HT-Demucs ONNX separation | 🔲 todo |
| 6 | Inter-deck sync — shared Phase clock | 🔲 todo |
| 7 | Automix execution — wire AutoMixDecision | 🔲 todo |

### Phase 3 — Keylock

Add the `rubberband` crate:
```toml
rubberband = "0.5"   # Rust bindings to librubberband
```

In `output.rs`, when `engine.keylock` is set:
- Buffer the raw decoded frames through `RubberBandStretcher` with `setTimeRatio(1.0 / rate)` and `setPitchScale(1.0)`
- Feed the stretched output to the output buffer instead of the direct interpolated samples

### Phase 5 — Stem buses

After HT-Demucs ONNX separates a track into 4 PCM arrays:
- Store `[PcmBuffer; 4]` instead of a single `PcmBuffer`
- In the callback: mix the 4 buses with their individual gain/mute states
- `effective_mix_gain()` in `deck.rs` becomes a no-op (real per-bus mix replaces it)
