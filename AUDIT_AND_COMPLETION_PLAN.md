# Offcut — Full-Codebase Audit & Completion Plan

**Date:** 2026-06-11 · **Method:** multi-agent review (9 subsystem reviewers + adversarial
verification of serious findings + completion audit) combined with a manual deep-read of the
entire audio path (Rust engine → napi → IPC → stores → mixer/UI). Both compilers are clean
(`cargo check` 0 errors, `tsc` web+node 0 errors) — everything below is logic/runtime, not types.

**Coverage:** Rust engine ✅ (verified) · renderer audio layer ✅ (manual deep-read) ·
analysis pipeline ✅ · performance UI ✅ (verified) · library/DB/IPC ✅ · Lineage ✅ ·
completion audit ✅. **Not yet audited** (session limits): DJ-software readers/writers
(rekordbox/serato/traktor/engine-dj), rekordbox-usb/ProLink internals, app pages/stores.
These need a follow-up pass — the USB **writer** especially, since a malformed PDB/ANLZ
export is the one bug class that can brick a gig.

---

## 1 · Critical & high bugs (all verified against the code)

### A1. Track-end events are randomly lost (stuck "playing" deck)
`native/audio-engine/src/lib.rs:397-446` — `on_time_update` and `on_ended` each clone the
**same** crossbeam channel receiver (`deck.rs:131`) and spawn a draining thread. Cloned
crossbeam receivers are work-stealing, not broadcast: every event goes to exactly one
consumer. Both callbacks are always registered (`src/main/engine/index.ts:121-133`), so
`AudioEvent::Ended` — sent exactly once per track end — is ~50% likely to be consumed and
discarded by the time-update thread. There is no fallback (the renderer never compares
`currentTime` to `duration`), so the deck nondeterministically freezes in the playing state
at end-of-track. TimeUpdates are likewise stolen, irregularly degrading the ~86 Hz stream.
**Fix:** one dispatch thread spawned at deck creation that fans out to both threadsafe
functions (or two dedicated channels).

### A2. Loading a new track keeps playing the previous track's stems
`lib.rs:89-94` — `load()` swaps `engine.pcm` but never clears `engine.stems`; the callback
gives stems strict precedence (`output.rs:104-117`); `playerStore.loadTrack`
(`src/renderer/src/store/playerStore.ts:248`) only resets the UI flag and never calls
`unloadStems()`. Stems auto-load for any track with a cached Demucs separation, so this is
routine: load track 1 (stems auto-load) → load track 2 → deck shows track 2's waveform but
audibly plays track 1's stems. **Fix:** `engine.stems.store(Arc::new(None))` inside `load()`
plus a defensive `unloadStems()` in `NativeAudioEngine.load()`.

### A3. Keylock: ~100 ms unreported latency + dropout on engage
`signalsmith.rs:19-29` — the FFI exposes `sms_output_latency` and `sms_seek` (the wrapper
was written explicitly to avoid the ramp-in) but both are dead code. The default Signalsmith
preset has ~100 ms latency: while keylock is engaged the reported position (and therefore
waveform playhead, beat phase under sync) leads the audible audio by that amount, and every
engage/seek/loop-wrap does an unprimed `sms_reset` → audible flam/dropout. **Fix:** subtract
`sms_output_latency()` when committing the cursor, and prime with `sms_seek` on every reset.

### A4. Packaged builds silently ship without the native engine
`package.json:13` — `build:mac` never runs `engine:build`, and electron-builder has no
extraResources mapping for `crate-audio-engine.node`. A distributed build silently falls back
to Web Audio, where keylock is a stored no-op flag (`audioEngine.ts:342`), sync is a silent
no-op (`audioEngine.ts:446`) **while the UI still shows KEY/SYNC as engaged**, and scrub does
nothing. **Fix:** chain `engine:build:napi` into the build scripts, add the .node to
`extraResources`, and make the renderer surface which engine is live (plus disable
keylock/sync buttons under Web Audio instead of lying).

### A5. Recording is a silent no-op under the native engine
`nativeAudioEngine.ts:231` returns `null` unconditionally; `recordingStore.startRecording`
bails with only a `console.warn`. The Rust engine has no tap/capture API at all. Under Web
Audio it *also* fails unless **both** decks have initialized their AudioContexts. **Fix:**
short-term, gate the REC button and show why; real fix is the master-bus architecture (§3).

### A6. Headphone cue is post-fader (Web engine)
`audioEngine.ts:118` — `gainNode → _preListenGain`: with the channel fader down the cue bus
is silent, which defeats pre-listening (the whole point of cueing the next track). **Fix:**
tap the pre-listen feed post-EQ/pre-fader (`eqHigh → _preListenGain`).

### A7. Auto-gain compounds into the fader and is wiped by fader moves
`playerStore.ts:291-300` — on each load: `engine.volume = engine.volume × correction`. The
correction multiplies whatever the previous correction left behind (volume creeps over a
session), and any fader/crossfader move (`Mixer.tsx:374-377` recomputes `volA × xA`) silently
erases it. There is no trim stage. **Fix:** dedicated gain staging — `engine.volume = trim
(track auto-gain) × channel fader × crossfader` computed in one place; track trim lives on
the deck store, never read-modify-written from the engine.

### A8. MIDI pitch mapping ignores pitch range — ~84% of fader travel dead
`midiEngine.ts:33` — maps CC to the full 0.5–2.0 contract range, but `setPlaybackRate`
clamps to the deck's ±8% pitch range, so only the centre sliver of a hardware fader does
anything. **Fix:** map CC through the deck's `pitchRange`.

### A9. Deck keyboard shortcuts fire while typing
`Deck.tsx:64` — global key handler doesn't check the event target, so typing a comment in
TrackDetail (space, Q, numbers…) triggers play/cue/loops on the live deck. **Fix:** ignore
events whose target is an input/textarea/contentEditable.

---

## 2 · Medium bugs worth fixing alongside (audio core)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| B1 | `stop()`/`load()`/stem re-anchor use `set_cursor` and race the callback's end-of-block commit (stop intermittently doesn't return to 0; stems re-anchor discarded) | `lib.rs:136-138, 91-92, 264-287` | route through `request_seek()` — the mechanism exists for exactly this |
| B2 | `seek`/`play(from)`/`set_loop` convert ms→frames with the **mix** SR even when stems (44.1k Demucs vs 48k mix) drive playback → seeks land ~8.8% off | `lib.rs:116-163` | add `active_sample_rate()` helper, use everywhere `position_secs()` does |
| B3 | MP3/AAC gapless trimming off — ~26 ms systematic offset vs every other DJ tool's beatgrids/cues | `decoder.rs:33-39` | `FormatOptions { enable_gapless: true, .. }` |
| B4 | Double-load race in `loadTrack` — two in-flight loads can interleave state (track A's waveform under track B) | `playerStore.ts:248` | load-generation token; ignore stale resolutions |
| B5 | Native/Web cache divergence on load: native doesn't reset `_looping`/`_rate`; Web resets rate to 1.0 — UI lies after track load depending on engine | `nativeAudioEngine.ts:72-89` | reset cached flags in `load()`; decide one rate-reset policy for both engines |
| B6 | Seek/beat-jump/hot-cues are dead on a synced deck — next block's sync snap overrides the cursor | `output.rs:138-154` | translate seeks on a synced deck into phase updates |
| B7 | VU freezes at last RMS on pause/stop | `output.rs:96` | zero/decay level on the silent paths |
| B8 | GL waveform and 2D overlay scroll on different clocks — beatgrid jitters against peaks | `WaveformGL.tsx:300` | drive both layers from one time source per frame |
| B9 | No WebGL teardown/context-loss handling — contexts accumulate on remount | `WaveformGL.tsx:251` | dispose buffers/programs on unmount; handle `webglcontextlost` |
| B10 | Crossfader/volume only reach the engine while Mixer is mounted | `Mixer.tsx:373` | move the volA/volB/xfade → engine effect into a store subscription |
| B11 | Set timeline shows minutes as hours | `SetTimeline.tsx:126` | fix the division |
| B12 | Sync slave's displayed rate is `ratio`, actual is `ratio × masterRate` | `playerStore.ts:628-633` | display effective rate; update on master rate change |

## 3 · Audio implementation improvements (the "do it properly" list)

1. **Single-output-stream master-bus architecture (the big one).** Each deck currently opens
   its own cpal stream; the OS mixes them. That architecture is *why* recording is impossible,
   why sync jitters (two independent callbacks reading each other's block-stale cursors), and
   why there's no master limiter or true cue bus. Move to **one** duplex stream owning a master
   callback that renders both decks: gives a sample-accurate shared clock (sync becomes exact),
   a recording tap (lock-free ring → WAV/Opus writer thread — closes TASKS.md's last native
   gap), master limiter, in-engine crossfader law, and a real pre-fader headphone cue bus with
   device routing. Everything else in this section composes with it.
2. **Sync: PLL instead of per-block hard snap** (`output.rs:138-154`). Snap only on engage;
   thereafter compute phase error per block and correct in the rate domain
   (`eff = ratio·masterRate·(1 + k·err)`, deadband <1 ms, clamp ±0.2%). Eliminates the audible
   graininess and stops the keylock stretcher being reset every block (the current >2-frame
   re-anchor check trips constantly under sync — this is why synced+keylock sounds wrong).
3. **Sync downbeat alignment** (already in TASKS.md): derive phase from `analysedBeatgrid`
   downbeats instead of "lock from here".
4. **Click-free parameter smoothing**: per-sample one-pole ramp (~5–10 ms) on master gain;
   short fade-out before the pause gate / fade-in on resume; 2–5 ms equal-power splice
   crossfade on seek and loop wrap; ramp EQ dB before rebuilding biquad coefficients.
5. **Resampling quality**: replace 2-point linear interpolation with 4-point Hermite (cheap,
   big aliasing win at pitch ≠ 0) — the declared `rubato` dependency is currently dead code;
   either use it for offline SR conversion at load or drop it.
6. **Stretcher tempo accuracy**: per-block `round(out×rate)` biases tempo up to ~0.05%
   (e.g. 512-frame blocks at 1.06 → effective 1.0605). Carry the fractional input remainder.
7. **EQ kill behaviour**: −24 dB floor isn't a kill; consider −∞ (full cut) at the bottom of
   the knob, and align mid-band Q (native 0.9 vs Web 0.8).
8. **Analysis correctness** (from the verified analysis review):
   - `beat-model.ts:93` — `exp()` on logits should be `sigmoid()`; thresholds become real probabilities.
   - Mel spectrogram diverges from Beat This! training config (n_fft, mel scale, norm, log) —
     the ONNX model currently sees out-of-distribution input; match the upstream config.
   - Octave-fold boundary: BPM of exactly 80/160 gets folded (`analyzerWorker.ts:92`).
   - Parabolic interpolation of autocorrelation peaks + fractional-period phase folding to
     stop 10–23 ms-hop beatgrid drift (`analyzerWorker.ts:234`, `beatTrackerWorker.ts:261`).
   - ffmpeg decode silently caps analysis at 8 min and accepts partial output (`audio-decode.ts:12`).
   - Always-on tempo-deviation cost in the DP tracker so grids don't wander through breakdowns.
9. **Misc engine hygiene**: latency-compensate the reported position by the device's output
   latency; denormal guards in the biquads; deck threads/registry cleanup on drop.

## 4 · Other subsystem findings (condensed)

**Library / IPC / settings** (structurally sound; two data-corrupting defects):
null patch values stringified to `'null'` (poisons CSV export + smart-playlist numerics);
M3U/CSV exports lose playlist order (unordered `IN` re-fetch); renderer-supplied keys
interpolated into SQL `SET` (whitelist needed); a smart-playlist customTag with space/dot
breaks loading of **all** playlists; ProLink error path leaks the network session and still
returns ok; Demucs jobs un-cancellable/orphaned on quit; schema migration swallows all
errors; re-import clobbers user-edited cues/grids/tags; auto-updater events sent nowhere;
`IN`-clause breaks >32k selection; AcoustID key setting ignored.

**Lineage**: credits/labels never deduped (crowd out the 8-branch cap); preview matcher
compares only first words → wrong-track audio; MusicBrainz query unescaped + top hit
unverified; two uncoordinated preview players; 1001Tracklists route is an advertised stub;
Rekordbox export writes `@Location`-less tracks with hand-rolled `encodeURI`; deterministic
"jitter"; unbounded http_cache.

**Performance UI**: stale-waveform flash on track load; BeatgridEditor leaks AudioContext on
decode failure and saves BPM rounded to 0.1 while editing at 0.01; `Waveform.tsx` is dead
code; no jog-wheel/LED feedback in MIDI; automix `scoreOrder` collides on duplicate tracks.

## 5 · Completion plan

**Phase 0 — Ship integrity (do first, ~a day)**
`build:mac/win` runs the napi build + extraResources packs the `.node` (A4); REC button gated
with a reason under native (A5 stop-gap); engine indicator in Settings; macOS signing/notarization
(currently configured to auto-update but unsigned).

**Phase 1 — Audio-core correctness (the nine A-bugs + B1–B7, ~2–3 days)**
All are small, surgical fixes with the exact mechanism identified above. This phase alone
makes the native engine trustworthy for a real set: track-end always fires, stems can't leak
across loads, keylock aligns, cueing works pre-fader, gain staging is sane, MIDI pitch works.

**Phase 2 — Audio quality pass (§3 items 2–7, ~3–5 days)**
PLL sync + downbeat alignment + smoothing + Hermite interpolation + keylock priming. After
this, synced+keylocked playback should survive an A/B ear test against Rekordbox.

**Phase 3 — Master-bus architecture (§3 item 1, ~1 week)**
One output stream, master mixer in Rust, recording tap (closes the last engine gap in
TASKS.md), limiter, real cue bus. Do after Phase 2 so the smoothing/PLL work lands in the
mixer rather than per-deck.

**Phase 4 — Analysis correctness (§3 item 8, ~2–3 days)**
Sigmoid + mel-config match + octave-fold + interpolated peaks + 8-min cap. Re-run analysis
over the library afterwards (grids change). Gate USB export QA on this — exported grids
inherit these errors.

**Phase 5 — Data safety (library/IPC list, ~2 days)**
The two corrupting bugs first (null-stringify, export order), then injection whitelist,
migration strictness, re-import merge policy, ProLink session lifecycle.

**Phase 6 — Feature completion (sequenced from TASKS.md + completion audit)**
1. ProLink Phase 3: persist captured sessions to `PlayedSet` (capture currently evaporates).
2. Automix execution: drive the existing decision model through native sync + stems.
3. Flux mode: replace wall-clock shadow with engine-time anchored + on-beat snap-back.
4. Lineage matching fixes (dedupe, preview matcher, MB verification) — small and high-value.
5. ProLink Phases 4–6, Set History Phases 3–5, auto-cue templates — per their plan docs.

**Phase 7 — Verification & the uncovered third**
- Audit the remaining subsystems: **rekordbox-usb writer** (PDB/ANLZ correctness — top
  priority), serato/traktor/rekordbox writers (library-corruption risk), pages/stores.
- Add a JS test runner (no `npm test` exists); seed it with regression tests for A1–A9.
- Real-hardware matrix: CDJ USB export, ProLink capture, MIDI controllers, output routing.

---
*Generated from the 2026-06-11 audit session. Full per-finding details with fix suggestions:
`/tmp/offcut_findings.txt` (session artifact) and the workflow transcripts under
`~/.claude/projects/.../subagents/workflows/wf_f12dd8ad-d6a/`.*
