# V2 Phase 1 — Performance Pro: Per-Deck FX Chain (implementation plan)

**Status:** Implementation plan for the V2 flagship's first concrete piece.
**Date:** 2026-06-20 · **Branch:** `claude/v2-planning-xu41pc`
**Prereq:** Phase 0 hardening (signing, test net) is a parallel gate, not a
blocker for *building* this.

---

## 0 · What already exists (don't rebuild)

A code read of `native/audio-engine/` shows the FX foundation is **partly built
and fully wired** — this changes the plan from "build FX" to "generalize +
surface FX."

| Piece | Status | Evidence |
|---|---|---|
| **DJ filter** (swept resonant LP/HP) | ✅ built, wired end-to-end | `filter.rs` (TPT-SVF, per-block glide), `lib.rs:set_filter`, `deck.rs:filter_knob`, IPC `engine:setFilter`, `nativeAudioEngine.setFilter` |
| **Beat-synced delay/echo** (feedback send) | ✅ built, wired end-to-end | `output.rs:apply_delay`, `lib.rs:set_delay`, `deck.rs:delay_*`, IPC `engine:setDelay`, `nativeAudioEngine.setDelay` |
| Per-deck EQ (3-band) + kill | ✅ built | `eq.rs`, `output.rs` (glided) |
| Master limiter / recording tap | ✅ built | `output.rs:Limiter`, `tap.rs`, `recorder.rs` |
| **Manual FX UI (filter knob / echo controls in the booth)** | ❌ **missing** | only `automixStore.ts` calls `setFilter`/`setDelay`; no Mixer/Deck control |
| **FX-chain abstraction** (ordered, multi-slot, selectable) | ❌ **missing** | filter + delay are two hardcoded steps with bespoke atomics |
| Reverb / flanger / phaser / bitcrush / noise / gate / roll | ❌ **missing** | no modules |

**Implication.** The current design hardcodes exactly two effects as distinct
atomics and distinct render steps in `DeckRenderer::render`. To add reverb /
flanger / etc. *and* let a DJ pick and order them (and later map them to the
XDJ/CDJ FX banks), we need a small **effects-graph abstraction** first — then
the existing filter + delay become the first two modules in it, and the UI
exposes the whole rack.

---

## 1 · Goal & scope of Phase 1

**Goal:** a per-deck FX rack a DJ can drive by hand — an ordered chain of
selectable effects with dry/wet and beat-synced parameters — built on the
master-bus engine, click-free, and real-time-safe.

**In scope:**
1. An **effects-graph abstraction** in Rust (a common `Effect` trait + a small,
   fixed-capacity per-deck chain) that the existing filter + delay migrate into.
2. **New effect modules:** reverb, flanger, phaser, bitcrusher, noise sweep,
   beat-gate, loop-roll-style "FX roll." (Filter + delay already exist.)
3. A **per-deck FX UI** (FX rack in the Mixer/Deck) that selects effects, sets
   dry/wet, toggles on/off, and shows beat-synced parameters.
4. The full **wiring spine** for the chain (Rust → napi → IPC → preload →
   contract → `nativeAudioEngine` → store/UI), plus **FX presets** persisted to
   the library DB.
5. **Tests** in the engine's existing style (Rust unit + an integration pass).

**Out of scope (deferred):** the sampler (next Phase 1 item — shares the FX
trait but is its own sound source), per-effect controller mapping (Phase 2,
once HID lands), DVS/timecode, broadcasting.

---

## 2 · Architecture — the effects-graph abstraction

### 2.1 The `Effect` trait (new `native/audio-engine/src/fx/mod.rs`)

Mirror the existing real-time discipline (no alloc / no lock / no syscall in the
callback; coefficients rebuilt per block from glided, atomically-published
params, exactly like `filter.rs` and `apply_delay` do today):

```rust
pub trait Effect: Send {
    /// Rebuild coefficients from smoothed params once per block (cheap).
    fn prepare(&mut self, block: usize, sample_rate: f32);
    /// Process one interleaved block in place, `chs` channels. Must be
    /// transparent when its wet/intensity has glided to 0 (so "off" = bypass).
    fn process(&mut self, buf: &mut [f32], chs: usize);
    /// Clear internal state (tails/rings) when the slot is disabled or swapped.
    fn reset(&mut self);
}
```

### 2.2 The per-deck chain *(decided: 3 slots, user-reorderable)*

A **3-slot** `FxChain` held in `DeckRenderer` (3 matches a CDJ/XDJ "FX bank" feel
and bounds CPU). Each slot has: an `enum FxKind` selector, a boxed `Effect`, an
enabled flag, a glided wet/intensity, and a **user-set order index**.
Boxing/allocation happens **off the audio thread**: the control side builds the
effect and hands it over via the same `ArcSwap` pattern the engine already uses
for `pcm`/`stems`, so the callback only ever swaps a pointer — never allocates.
Reordering is just publishing a new order index (an atomic), so the callback
re-reads the order each block with zero allocation.

**Fader-as-reference-point (how reorderable coexists with echo-out).** Today the
delay is deliberately **post-fader** so the echo tail rings as you pull the fader
down (the classic echo-out). To keep that while letting the user reorder freely,
the **channel fader is itself a fixed node in the chain order**. Slots the user
places *before* the fader node are pre-fader inserts (filter/reverb/flanger want
this); slots placed *after* it are post-fader sends (echo/roll want this). So the
render is one ordered walk:

```text
… EQ → [ slots before fader ] → channel gain (fader) → [ slots after fader ] → master sum …
```

The user drags a slot across the fader marker to change its pre/post character —
one model, fully reorderable, and echo-out is preserved by placing echo after the
fader. This is slightly more than two fixed sub-lists (it tracks an order with an
embedded fader marker), reflected in the effort below.

### 2.3 Param transport (reuse the existing pattern exactly)

Per-deck atomics in `deck.rs`, one set per slot, `f32::to_bits` in `AtomicU32`
(identical to `filter_knob` / `delay_mix` today). A slot's params are a small
fixed struct: `{ kind: u8, enabled: bool, wet: f32, p0: f32, p1: f32, p2: f32 }`
where `p0..p2` mean different things per `FxKind` (documented per effect). One
napi setter `set_fx_slot(slot, kind, enabled, wet, p0, p1, p2)` replaces the
need for a bespoke setter per effect — though `set_filter`/`set_delay` stay as
thin shims for back-compat with `automixStore`.

---

## 3 · Effect modules (DSP approach + params)

All beat-synced times are computed JS-side from the deck BPM (as `set_delay`
already does) and passed in ms / as a beat-fraction param.

| Effect | DSP approach | Params (p0/p1/p2) | Notes |
|---|---|---|---|
| **Filter** (exists) | TPT-SVF, `filter.rs` | knob −1..+1 | migrate into a slot |
| **Echo/Delay** (exists) | feedback ring, `apply_delay` | time, feedback, (wet=slot wet) | post-fader slot |
| **Reverb** | Freeverb (8 combs + 4 all-pass / ch) or FDN | size, damping | classic, cheap, well-understood; fixed buffers sized at `new` |
| **Flanger** | short modulated delay (1–10 ms) + feedback | rate, depth, feedback | LFO phase advanced per sample |
| **Phaser** | 4–6 cascaded all-pass, modulated | rate, depth | shares the LFO helper with flanger |
| **Bitcrusher** | sample-rate decimation + bit quantize | downsample, bits | trivial, no buffers |
| **Noise sweep / riser** | filtered white noise, env to wet | tone, rise | white-noise gen + the existing SVF |
| **Beat-gate / trance-gate** | beat-synced amplitude gate | rate (beats), depth | square/saw LFO on amp |
| **FX roll** | capture N beats into a ring, loop it | length (beats) | "roll" feel; reuses ring infra |

Build order within Phase 1: **reverb → flanger → phaser → bitcrush → gate →
noise → roll** (descending value/effort). Filter + delay are already done; they
just move into the chain.

---

## 4 · The wiring spine (every effect travels this once)

This is the existing path, verified against the codebase — new params follow it:

1. **Rust state** — atomics in `native/audio-engine/src/deck.rs` (per slot).
2. **DSP** — module under `native/audio-engine/src/fx/`, run in
   `DeckRenderer::render` (`output.rs`).
3. **napi setter** — `lib.rs` (`set_fx_slot`, keep `set_filter`/`set_delay`).
4. **Main IPC** — `src/main/engine/index.ts` (`engine:setFxSlot`).
5. **Preload** — `src/preload/index.ts` + `index.d.ts` (`engine.setFxSlot`).
6. **Contract** — `src/renderer/src/lib/audioEngineContract.ts` (interface).
7. **Native engine binding** — `src/renderer/src/lib/nativeAudioEngine.ts`
   (calls `window.api.engine.setFxSlot`); **Web fallback** no-op in
   `audioEngine.ts` (mirror the existing `setFilter(){}` stubs so the UI degrades
   honestly under Web Audio — disable FX with a tooltip, like KEY/SYNC do).
8. **Store + UI** — a new `fxStore` (or extend `playerStore`) + the FX rack UI.

> The `automixStore` already calls `setFilter`/`setDelay`; after the refactor it
> should drive the chain through the same slot setter so manual and automix FX
> share one path (and can't fight over the deck's filter).

---

## 5 · UI — the per-deck FX rack

- **Placement:** a compact FX strip per deck in the Mixer (and a fuller rack in
  the performance view). Three slots, each: effect selector, on/off, a big
  dry/wet, and 1–2 param knobs whose labels change with the effect.
- **Beat-sync:** a beat-fraction selector (1/4, 1/2, 1, 2, 4) feeding the
  JS-side ms computation — same source the delay already uses.
- **Honest under Web Audio:** if the native engine isn't loaded, disable the FX
  rack with the existing tooltip pattern (KEY/SYNC already do this).
- **Controller-ready:** design the slot model so Phase 2 HID mapping (XDJ-AZ /
  RX3 / CDJ-3000 FX sections) maps 1:1 onto slots — keep the param model flat
  and numeric, not UI-coupled.

---

## 6 · Persistence

- **FX presets** (named slot configurations) in a new `fx_presets` table via a
  `schema.ts` migration (the audit hardened migrations to only swallow
  "duplicate column" — follow that strictness).
- **Last-used FX per deck** is session state, not library data — keep it in the
  renderer store, not the DB.

---

## 7 · Testing

Match the engine's existing bar (the repo runs Vitest; Rust has 21+ unit tests,
clippy clean):

- **Rust unit per effect:** bypass-is-transparent (wet=0 → input==output within
  epsilon), no NaN/denormal blow-up over a silence→signal→silence sweep, tail
  decays, param glide monotonic. (Model on the existing `eq`/`limiter`/`hermite`
  tests.)
- **Chain integration:** 3 slots, reorder, enable/disable mid-stream → no click
  (assert no inter-block discontinuity > threshold), CPU within budget.
- **Wiring test:** a contract-level test that `setFxSlot` reaches the deck (the
  repo already has engine integration tests under `/tmp` per TASKS history).
- **Regression:** confirm `automixStore`'s filter/delay still behave after they
  move onto the slot path.

---

## 8 · Task breakdown & rough effort

| # | Task | Effort |
|---|---|---|
| 1 | `Effect` trait + `FxChain` (3 slots, **reorderable w/ fader-marker node**) + ArcSwap handover | 2 d |
| 2 | Migrate filter + delay into slots; keep `set_filter`/`set_delay` shims | 1 d |
| 3 | `set_fx_slot` napi + full wiring spine (IPC→preload→contract→native) | 1 d |
| 4 | Reverb module + tests | 1.5 d |
| 5 | Flanger + phaser (shared LFO) + tests | 1.5 d |
| 6 | Bitcrush + beat-gate + noise + roll + tests | 2 d |
| 7 | `fxStore` + FX rack UI (Mixer strip) + Web-fallback disable | 2.5 d |
| 8 | FX presets table + migration + save/load UI | 1 d |
| 9 | Integration/regression pass + automix re-point | 1 d |
| | **Total** | **~13.5 d** |

**Suggested first PR (smallest shippable slice):** tasks 1–3 + 7 — the
abstraction, the two existing effects surfaced in a manual FX rack, end-to-end.
That alone gives DJs hands-on filter + echo (a real, demoable win) and proves
the chain before the new DSP modules land.

---

## 9 · Risks & mitigations

- **Real-time safety** is the cardinal rule (`output.rs` header: "wait-free: no
  mutex, no allocation, no syscall"). All effect construction/boxing happens off
  the audio thread; the callback only swaps an `ArcSwap` pointer. Fixed-capacity
  chain + pre-sized buffers (reverb/delay rings allocated in `new`).
- **CPU budget** with 4 decks × 3 slots: bound slot count, profile reverb (the
  heaviest), keep `prepare` per-block not per-sample (as filter/EQ already do).
- **Denormals** in feedback effects (reverb/flanger/delay): reuse the existing
  `ANTI_DENORMAL` bias pattern from `output.rs`.
- **Don't regress automix:** point `automixStore` at the new slot path and keep
  the `set_filter`/`set_delay` shims so nothing else breaks.

---

## 10 · Decisions & remaining open

**Decided (2026-06-20):**
- **Slot count:** ✅ **3** (CDJ-feel, CPU-safe).
- **Ordering:** ✅ **user-reorderable**, via the fader-as-reference-point model
  in §2.2 (preserves echo-out while staying fully reorderable).

**Still open:**
- **FX-on-master vs per-deck only:** Phase 1 is per-deck. A master FX send is a
  natural follow-up — noted, not built yet.

*Grounds: `native/audio-engine/src/{output,deck,filter,eq}.rs`,
`src/main/engine/index.ts`, `src/renderer/src/lib/{audioEngineContract,
nativeAudioEngine,audioEngine}.ts`, `src/renderer/src/store/automixStore.ts`.
See `V2_PLANNING.md` for the surrounding V2 direction.*
