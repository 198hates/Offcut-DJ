# Offcut — Outstanding Tasks

Working jobs list. Last updated **2026-06-12**.
Source of truth is the code; the older plan docs (`PERFORMANCE_FEATURES_PLAN.md`,
`PROLINK_B2B_PLAN.md`, `SET_HISTORY_PLAN.md`, `LEXICON_FEATURES.md`) are background.

---

## ✅ Done this session (native audio engine — `id·2026·009`)

The native Rust engine (`native/audio-engine/`) was the critical path. It did not
even compile as committed; now it's the live backend with full DSP.

- [x] **Installed the Rust toolchain** (rustup / stable 1.96; `~/.cargo/bin`, shells need `. "$HOME/.cargo/env"`).
- [x] **Fixed the build** — it never compiled with this toolchain:
  - missing `tokio` dependency (used by `spawn_blocking`);
  - cpal `Stream` is `!Send`/`!Sync` — moved it out of the shared `DeckEngine` into `DeckHandle` behind a `Send`-asserting `StreamHandle`;
  - `on_ended` threadsafe-fn type-inference fix.
- [x] **3-band EQ** — RBJ biquads (low-shelf 200 Hz, mid-peak 1 kHz, high-shelf 8 kHz) in `src/eq.rs`, applied per channel in the callback. Unit-tested.
- [x] **Real stems** — `StemSet` + 4-bus mixing with mute/solo/trim in the callback (`src/deck.rs`, `output.rs`); `loadStems`/`unloadStems`/`hasStems` plumbed through IPC → preload → `nativeAudioEngine.ts`. Unit-tested + runtime-verified. **User confirmed: sounds good.**
- [x] **Keylock** — pure-Rust WSOLA time-stretcher (`src/stretch.rs`), pitch-preserving tempo, integrated in the callback (engages only when tempo ≠ 1×). Uses normalized cross-correlation. Unit-tested (pitch preservation). Driven by the existing KEY button.
- [x] **Sync (shared Rust clock)** — slave deck follows the master's transport via a deck registry; `syncTo`/`updateSync`/`clearSync`/`isSynced`. `playerStore.toggleSync` + **SYNC button** in `Deck.tsx`. Runtime-verified (locks within ~11 ms).

Verification: 15/15 Rust unit tests pass, clippy clean, full TS typecheck 0 errors,
app launches with `[NativeEngine] loaded`.

---

## 🐛 Fixed 2026-06-08 (regressions found once native became the live engine)

- [x] **Looping rewound rapidly** — `nativeAudioEngine` passed loop points in **seconds** into the **ms** IPC/Rust (1000× off → ~2 ms micro-loop). Fixed: `setLoop`/`seek`/`play(from)` now convert seconds→ms (×1000). (Latent since Phase 3; only surfaced now that native is live.)
- [x] **Sync weirdness on a paused master** — slaving to a stopped deck snapped to a frozen position but still advanced within each block → stutter. Fixed: a synced deck now holds silent while its master is paused, and follows once it plays.
- [x] **Mutual-sync guard** — `toggleSync` refuses to sync to a deck that's already synced (prevents A→B + B→A fighting / Arc cycle).
- [x] **Seek/scrub** — (a) `seek`/`play(from)` were also seconds-vs-ms (×1000) — fixed; (b) scrubbing-while-playing was silent because the audio callback's per-block cursor commit overwrote the ~60/s in-flight seeks. Fixed with a one-shot seek request (`seek_pending`/`seek_target` → `request_seek`/`take_seek_request`) the callback adopts at the block boundary, so seeks are never lost.
- [x] **Scrub while paused** (needle search) — added an engine scrub mode (`scrubbing` flag, `scrub_begin`/`scrub_end`): while paused + scrubbing, the callback renders audio from the previous to the current hand position at hand velocity (forward/reverse; silent when still). Plumbed through contract `scrubBegin`/`scrubEnd` → IPC → preload → store `scrubStart`/`scrubEnd` → WaveformGL drag (mousedown/up). Web Audio = no-op. Runtime-verified.
- [x] **Deck B mirroring** — removed `flex-row-reverse`/`text-right` so Deck B's controls match Deck A (was a mirrored-deck layout).
- Note: never `cp` the built `crate-audio-engine.node` over the copy a running app has mmap'd — it corrupts the file and segfaults the next load. Kill the app first, then build+copy, then relaunch.

## 🐛 Fixed 2026-06-12 (audit Phase 1 — see `AUDIT_AND_COMPLETION_PLAN.md`)

- [x] **Lost end-of-track events** — `onTimeUpdate`/`onEnded` each consumed the same MPMC
  channel (work-stealing, not broadcast) → `Ended` randomly swallowed, deck stuck "playing".
  Now one dispatch thread per deck fans out to both callbacks.
- [x] **Stale stems on load** — Rust `load()` now clears `stems` (they take playback
  precedence, so a new track kept playing the old track's stems); JS side also unloads
  defensively and resets its `_looping`/`_rate` caches.
- [x] **Keylock latency + ramp-in** — `sms_output_latency` now subtracted from all reported
  positions (playhead was ~100 ms ahead of the audio while keylocked); stretcher resets are
  primed via `sms_seek` (no more flam/dropout on engage, seek, loop wrap).
- [x] **Cursor races** — `stop()`/`load()`/stem (re)anchor now use `request_seek` instead of
  bare `set_cursor` (the callback's end-of-block commit could overwrite them).
- [x] **Stems-SR unit bug** — `seek`/`play(from)`/`setLoop` convert ms→frames with the
  *active* source's sample rate (was always the mix's; 44.1k stems on a 48k mix put every
  seek/loop ~8.8% off).
- [x] **Seek dead under sync** — seeking a synced deck now re-anchors `sync_phase`, so
  beat-jump/hot-cues work instead of snapping back the next block.
- [x] **Synced beat-jump drifted under keylock** (found by ear after the above) — positions
  are reported in *audible* coordinates (cursor − stretcher latency) but seeks and the sync
  snap consumed them as *input* coordinates, so each synced jump baked ~50–60 ms of extra
  misalignment into the phase (cumulative), and engaging keylock mid-sync shifted the lock.
  Seeks and the snap now add `report_latency` back when converting to cursor frames.
  Verified with a direct-addon integration test (`/tmp/sync_keylock_coord_test.js`): old
  binary drifts −0.157 s over keylock-engage + 2 jumps, fixed binary holds within 0.023 s.
- [x] **MP3 gapless** — symphonia `enable_gapless` on (was off → ~26 ms systematic offset vs
  Rekordbox/Serato grids on MP3/AAC).
- [x] **Gain staging** — auto-gain is now a real trim stage: `lib/mixBus.ts` owns
  `engine.volume = trim × fader × crossfader` via store subscriptions (was multiplied into
  the fader on each load → compounded across tracks, wiped by any fader move; also fixes
  faders only applying while the Mixer was mounted).
- [x] **Pre-fader cue** — Web engine pre-listen tap moved post-EQ/pre-fader (was post-fader:
  silent headphones with the channel fader down).
- [x] **MIDI pitch dead travel** — pitch CC now maps through the deck's ±pitchRange (was
  0.5–2.0 → ~84% of fader travel clamped away); continuous controls accept 14-bit pitchbend;
  MIDI-learn records the actual source device.
- [x] **Typing triggered transport** — deck shortcuts ignore key events from
  textarea/select/contentEditable (Space in a comment field started the deck).
- [x] **Double-load race** — `loadTrack` is generation-guarded; a superseded load can no
  longer interleave its waveform/playback with the newer one.
- [x] **VU stuck on pause** — silent callback paths now zero the level.
- Verified: 11/11 Rust tests, clippy clean, both tsc projects clean, release `.node` rebuilt.

## 🛡 Data safety 2026-06-12 (audit Phase 5)

Corruption bugs: track edits no longer store the STRING 'null' when clearing a
field (`typeof null === 'object'`); M3U/CSV playlist exports preserve playlist
order (bare `IN()` returned table order). Hardening: update statements
whitelist columns (no renderer keys in SQL); smart-playlist JSON paths quoted +
one bad rule degrades to an empty playlist instead of killing the list; schema
migrations only swallow "duplicate column"; re-import fills empty
comment/tags/cues/grid instead of clobbering local edits; ProLink error path
stops the leaked session + start reports failure, library matching normalises
BOTH sides (custom SQLite fn); Demucs children killed on quit; LIKE wildcards
escaped + path mapping replaces only the prefix; cue-sheet frames can't emit
:75; AcoustID honours the configured key; lineage engine rebuilds close the
old SQLite handle; updater events actually reach the renderer; deletes chunked
past the 32k bound-param limit.

## 🎯 Analysis correctness 2026-06-12 (audit Phase 4) — commit dd714e5

Beat This! preprocessing now matches upstream exactly (slaney mel/1024 FFT/
magnitude/log1p/centered — was out-of-distribution + a +23 ms shift); sigmoid
on logits; chunked 1500-frame inference; sub-frame beat positions everywhere
(parabolic peaks, fractional phase fold); always-on DP tempo-continuity;
full-track decode (8-min cap gone, ffmpeg failures loud); structure cues use
the full energy curve; analyseBpm no longer clobbers existing grids;
AudioContext leaks fixed. **Re-analyse the library to regenerate grids** —
old grids carry the old errors.

## 🚌 Master-bus architecture 2026-06-12 (audit Phase 3)

- [x] **One output stream for everything** — decks no longer own cpal streams; a
  `MasterBus` renders every registered deck via per-deck `DeckRenderer`s (all the
  Phase-2 DSP state moved intact), sums them, and shares one sample clock — sync now
  reads the master deck's cursor committed in the *same* callback.
- [x] **Recording on native** (closes the last engine gap) — the master mix is tapped
  into a lock-free SPSC ring (`ring.rs`, never blocks the callback) drained by a
  writer thread streaming 16-bit PCM WAV (`recorder.rs`, header finalised on stop).
  REC button records to `~/Music/Offcut Recordings/mix-<ts>.wav` and reveals the file
  in Finder on stop. `recordingStream` Web Audio path unchanged as fallback.
- [x] **Master peak limiter** — instant attack / 80 ms release just below full scale,
  so two hot decks summed can't clip the DAC.
- [x] **Output-device switching** rebuilds the single master stream (per-deck routing
  is reserved for a future cue-bus feature).
- Gotcha discovered: napi sync fns surface `Result::Err` as a *returned* `Error`
  value, not a throw — the IPC layer converts (`instanceof Error` check).
- Verified: 21/21 Rust tests (ring SPSC incl. concurrent sequence test, WAV recorder,
  limiter, hermite, carry, EQ, stems), clippy clean, tsc clean; integration:
  2 s mix recorded → valid WAV, correct duration, non-silent; PLL + free-run +
  synced-seek regressions all pass on the new architecture; deployed + relaunched.

## 📦 Ship integrity 2026-06-12 (audit Phase 0)

- [x] **Packaged builds now include the native engine** — `build:mac/win/linux` chain
  `engine:build`, which compiles and copies via `scripts/copy-engine.js` to
  `native/audio-engine/crate-audio-engine.node`; electron-builder packs that file via
  `extraResources` and the loader reads `process.resourcesPath` in production (the old
  exe-relative candidate never matched). A dist build without Rust now FAILS loudly
  instead of silently shipping the Web Audio fallback.
- [x] **Dev-loop landmine fixed** — `engine:build`/`engine:dev` no longer copy into
  `out/main` (electron-vite wipes it); they refresh the dev load path directly.
  Still applies: quit the app before rebuilding the engine (mmap'd .node).
- [x] **Honest UI under the Web Audio fallback** — KEY and SYNC disable with an
  explanatory tooltip when the native engine isn't loaded (they were silent no-ops
  shown as engaged); REC shows a toast explaining why recording is unavailable
  (native engine / decks not initialised) instead of a console.warn.
- [x] **Linux icon** points at `resources/icon.png` (was the .icns).
- [x] **Updater check no longer throws unhandled** when app-update.yml is absent
  (--dir builds / offline).
- Verified end-to-end: `electron-builder --mac --arm64 --dir` packs the engine into
  `Contents/Resources/`, and the packaged app launches with `[NativeEngine] loaded`
  from that path (ad-hoc linker signature runs fine locally on arm64).
- [ ] **Signing/notarization** — still `identity: null` while `publish` is configured
  for GitHub auto-update. Needs an Apple Developer ID (user action) before release.

## 🎧 Audio-quality pass 2026-06-12 (audit Phase 2)

- [x] **PLL sync** — the slave no longer hard-snaps its cursor every block (that
  per-block snap was audible graininess and force-reset the keylock stretcher).
  It snaps only on engage / large error (>50 ms, e.g. master seeked) and otherwise
  corrects phase in the rate domain (±0.2 % max, 0.5 ms deadband, 0.5 s τ).
  Verified: 0.0 ms offset spread over 4 s, monotonic positions, 1.7 ms drift
  through a master tempo change, pause/resume re-locks (`/tmp/pll_test.js`).
- [x] **Synced deck plays alone** — a synced deck with a paused master used to hold
  silent (playhead moved, no audio — user-reported with sync+keylock). It now
  free-runs at the synced tempo and re-anchors the phase when the master resumes
  (no jump on either deck; re-press SYNC to re-beat-align). Verified:
  `/tmp/sync_freerun_test.js` — audible while master paused, exact tempo, −0.0 ms
  drift after resume.
- [x] **Beat-aligned SYNC engage** — `toggleSync` now matches beat phase from both
  tracks' `analysedBeatgrid`s (≤ half-beat shift, like CDJ BEAT SYNC); falls back
  to "lock from here" when a grid is missing.
- [x] **Click-free engine** — per-sample one-pole channel-gain smoothing (no fader
  zipper), one-block fade-out tail on pause (no truncation click), ~3 ms splice
  crossfade on seeks / loop wraps / sync snaps, per-block EQ gain glides, and an
  anti-denormal bias ahead of the filters.
- [x] **Hermite interpolation** — all source reads (straight, scrub, stretcher
  feed) use 4-point Hermite instead of linear: less aliasing/HF loss at pitch ≠ 0.
- [x] **Stretcher tempo accuracy** — fractional input carry replaces per-block
  `round()` (which biased tempo up to ~0.05 % at fixed block sizes). Unit-tested.
- [x] **EQ kill + parity** — knob floor (−24 dB) now drives a −40 dB full cut in
  both engines; Web mid-band Q aligned to 0.9; Web EQ/volume changes glide via
  `setTargetAtTime` to match the native smoothing.
- Verified: 15/15 Rust tests, clippy clean, tsc clean, full integration suite
  (PLL + synced-seek matrix + keylock coordinates) passing; deployed + relaunched.

## 🔧 Native engine — remaining / refinements

- [x] **Keylock artifact tuning** — in-house WSOLA flammed transients on big shifts; replaced with **Signalsmith Stretch** (vendored MIT C++, compiled into the addon via `cc`; Accelerate FFT on macOS). Runtime-verified; awaiting a listen on big shifts.
  - [ ] Optional: prime with `sms_seek` to remove the brief ramp-in on keylock-engage / seek-while-keylocked.
- [ ] **Sync downbeat alignment** — phase is currently "lock from here" (current playheads), not beatgrid-downbeat aligned. Use `analysedBeatgrid` to align downbeats.
- [ ] **Verify synced + keylock together by ear** — wired and runs, but only tested separately at runtime.
- [ ] **Recording on native output** — `recordingStream` is `null` under the native engine (it routes straight to hardware). Needs a virtual loopback / tap to record the mix. Last native gap vs the Web Audio engine.
- [ ] **Output-device routing** — implemented in Rust (`setOutputDevice`) but unverified across real devices.

---

## 🎚 Performance features (were blocked on the engine — now unblockable)

From `PERFORMANCE_FEATURES_PLAN.md`. The decision models already landed (commit `783f3d0`);
execution needed the engine, which now exists.

- [ ] **Stem separation end-to-end polish** — Demucs pipeline + native stem buses now both exist; wire/verify the full flow and the "Offcut register" UI.
- [ ] **Confidence-aware auto-mix execution** — drive the automix decision model through the native engine (sync + stems are now available).
- [ ] **Flux mode** — engine timeline is solid now; finish the "rehearsal room".

---

## 🔌 ProLink B2B / Set History (`id·2026·013`)

ProLink Phases 1–2 done (`7a73355`, `a81d1bf`). Remaining:

- [ ] **Phase 3** — capture logic → `PlayedSet` (played-detection, attribution).
- [ ] **Phase 4** — pre-flight + resilience.
- [ ] **Phase 5** — real-hardware test matrix.
- [ ] **Phase 6** — fold into set-history.
- [ ] Set History (`SET_HISTORY_PLAN.md`): Phase 3 (audio fingerprint + streaming audition), Phase 4 (acquire & replace), Phase 5 (wider field — gated on a data route).

---

## 🗂 Lexicon features

Tier 1 fully shipped. Remaining:

- [ ] **Auto-cue generation with templates** (Tier 3) — depends on correct beatgrids.
- Note: the doc lists "Beatgrid Editor (visual)" as remaining but it's actually **done** (`BeatgridEditor.tsx`).

---

## 🧹 Housekeeping

- [ ] Large uncommitted working tree predates this session (incl. the Web Audio stem work). Decide what to commit; the native-engine changes here are a coherent unit to commit on their own.
- [ ] `crate-audio-engine.node` is gitignored — building it locally (`npm run engine:build`) is required, and its presence auto-activates the native engine over Web Audio.
