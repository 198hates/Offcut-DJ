# Implementation Plan · Performance Features (Engine-Dependent)

**Status:** Build plan / architecture — BLOCKED on native engine (`id·2026·009`)
**Authored:** 21 May 2026
**Doc ref:** `id·2026·015`

Implementation detail for the features that depend on the native real-time audio engine (`id·2026·009` Phase 4+) and therefore come *after* the brand-native trio (`id·2026·014`) and the analysis spine. These are where OD-01 earns parity with the incumbents on live performance, plus two places it can lead. Covered here:

1. **Stem separation** — table-stakes (everyone has it), done in the Offcut register.
2. **Confidence-aware auto-mix** — automix that hands back to the DJ when unsure (a genuine differentiator).
3. **Flux mode & the rehearsal room** — the timeline tricks that make it feel alive.

The honest framing: #1 is mandatory and well-trodden; the work is integration, not invention. #2 and #3 are where the architecture (honest grids, the running order) lets us do something the others structurally can't.

---

# Feature 1 · Stem separation

**The pitch:** isolate/remove vocals, drums, bass, melody live — but woven into the Offcut working surface rather than bolted on as a separate panel.

## Reality check
Every major platform now has this (Serato, Traktor, Rekordbox, VirtualDJ, djay, Engine DJ). It's table-stakes: not having it reads as unfinished. So this is a *cost of entry*, not a differentiator. The differentiation is purely in the integration quality and the register.

## Implementation

### The model
- **HT-Demucs** (Hybrid Transformer Demucs) is the standard high-quality 4-stem separator (drums/bass/vocals/other), permissively licensed (MIT code; confirm weights as with Beat This!). Export to ONNX and run in the same in-process runtime as beat detection and embeddings — no second ML stack.
- Two modes, like the incumbents:
  - **Pre-prepared** (analyse stems on import/idle, cache them) — cheaper at playtime, the default.
  - **Real-time** (separate on the fly) — heavier, needs the native engine's headroom; a later optimisation.

### The engine side
- The audio engine (`id·2026·009`) gains four per-deck stem buses. Each deck can mute/solo/gain/EQ a stem independently, summed before the deck's main fader.
- Stem state lives in the engine, surfaced to the UI via the state snapshot — same pattern as everything else.

### The Offcut register (the only real differentiation)
- Stems shown as **four bands in the same earthen-palette, confidence-shaded waveform language** as the main view — not a new UI dialect. Drums/bass/vocals/other map to four of the categorical earth tones.
- Stem controls in the **FN-BUS vocabulary** — light-up pictogram cells for mute/solo per stem, with the corner-LED active state.
- Stem-FX (echo a vocal, filter a drum bus) use the existing FX register.
- The point: a DJ who knows the OD-01 surface already knows how to use stems, because it speaks the same language.

## Tooling
| Concern | Tool | Licence |
|---|---|---|
| Separation model | HT-Demucs | MIT code; check weights |
| Inference | ONNX runtime (shared) | MIT |
| Engine buses | the native engine | own |

## Effort
**Medium.** The model is known; the engine bus work is real but bounded; the UI is mostly reusing existing patterns. Depends on `id·2026·009` Phase 4.

---

# Feature 2 · Confidence-aware auto-mix

**The pitch:** an automix that only auto-handles transitions it's confident about, and hands back to the DJ when it isn't — a co-pilot, not an autopilot. No competitor can do graceful hand-back because none of them carry per-transition confidence.

## Why it's ours
Everyone's building automix, but they're mostly "background-set autopilot." Ours is different *because of honest grids* (`id·2026·014` F1): we have per-beat confidence, harmonic data, and energy. That lets the automix reason about *how sure it is* of each upcoming blend and behave accordingly.

## Implementation

### The decision model
For each candidate transition, score confidence from:
- **Grid confidence** on both tracks around the mix region (low confidence → risky beatmatch).
- **Harmonic compatibility** (Camelot adjacency).
- **Tempo gap** (within comfortable range?).
- **Energy continuity** (does the blend make musical sense?).

Three behaviours by confidence band:
- **High** — auto-blend cleanly (beatmatched, EQ-swapped, on-grid).
- **Medium** — auto-blend but flag it: *"I'll take this one, but watch it."*
- **Low** — **hand back**: *"This next one has a drift-prone intro — you take it."* The system cues the next track, sets up the mixer, and waits for the DJ.

```typescript
interface AutoMixDecision {
  fromTrack: TrackRef; toTrack: TrackRef;
  confidence: number;
  band: 'auto' | 'assisted' | 'handback';
  reason: string;              // "low grid confidence in B's intro"
  proposedTransition: TransitionPlan;
}
```

### The UX
- Runs against a **running order** (`id·2026·014` F2) — it mixes *your* planned set, not a random shuffle.
- The hand-back is the signature moment: instead of failing or fudging a bad blend, it gracefully gives you control with a clear reason, in the honest-grid spirit. You can let it drive the easy stretches and take the hard corners yourself.
- Visualised on the running order: each transition shows its band (auto/assisted/handback) ahead of time, so you know which moments are yours.

## Tooling
None external. Decision logic over the contract + the native engine for execution. Depends on `id·2026·009` Phase 5 (sync) and `id·2026·014` (running order, honest grids).

## Effort
**Medium**, but gated on the engine and the running order. The logic is buildable and testable against the mock early; execution needs real sync.

---

# Feature 3 · Flux mode & the rehearsal room

## 3a · Flux mode
**The pitch:** scratch, juggle, backspin, or jump around — then the track snaps back to where it *would* have been, on-beat, as if you'd never left. (Traktor has this; it's beloved by technical DJs.)

### Implementation
- The engine maintains a **"shadow playhead"** that keeps advancing at the track's tempo even while the audible playhead is being manipulated. On release, audible snaps to shadow.
- Entirely an engine-timeline feature: needs the solid sample-accurate timeline from `id·2026·009` Phase 4, plus the beatgrid for "on-beat" snapping.
- UI: a FN-BUS toggle; the waveform shows the shadow position as a ghost marker while flux is active — honest about where you'll land.

### Effort
**Low–medium**, but strictly gated on a rock-solid engine timeline. Cheap once that exists; impossible before.

## 3b · The rehearsal room
**The pitch:** practise your running order's hard transitions silently against the live output position — VirtualDJ's Sandbox idea, extended from "preview the next move" to "rehearse the whole programme."

### Implementation
- Builds on the engine's ability to run a **silent secondary timeline** (the same shadow-playhead machinery as flux, plus a non-audible deck pair routed nowhere).
- Tied to the **running order** (`id·2026·014` F2): step through your planned transitions, drill the awkward ones, and the app remembers which you've rehearsed (marking them on the running order).
- The editorial framing makes it natural: you *rehearse the programme* before you perform it. Prep that bridges into performance — and a feature no club-focused competitor frames this way.

### Effort
**Medium–high.** Needs the engine and the running order. A later, distinctive addition rather than a launch feature.

---

# How these depend on the foundations

```
  id·2026·009 (engine) ──── Phase 4 timeline ───┬── stems (buses)
                            Phase 5 sync ────────┼── confidence automix (execution)
                                                 ├── flux (shadow playhead)
                                                 └── rehearsal (silent timeline)
  id·2026·014 (brand trio) ── honest grids ──────┴── automix confidence bands
                              running order ──────── automix target, rehearsal target
```

Everything here sits on top of the hard native engine and the brand-native trio. None of it should be attempted before those exist — but all of it can be *designed and mocked* early so the engine work has clear targets.

---

# Phasing

These interleave with the engine plan (`id·2026·009`) rather than forming a separate track:

**After engine Phase 4 (timeline solid):**
- Stems (model + buses + Offcut-register UI) — ~4–6 weeks
- Flux mode — ~1–2 weeks (cheap once timeline exists)

**After engine Phase 5 (sync solid) + brand trio:**
- Confidence automix — ~3–4 weeks
- Rehearsal room — ~3–4 weeks

## What to hand Claude Code first (early, against the mock)
1. **Stem UI in the Offcut register** — four-band waveform + FN-BUS stem controls, against mock stem data. The visual language can be built and reviewed long before the model or engine is ready.
2. **The automix decision model** — pure scoring logic producing `AutoMixDecision`s over the contract, testable against mock grids and a mock running order, with no execution. The brain before the hands.
3. **The flux shadow-playhead logic** — as a pure timeline simulation (no audio), to validate the snap-back behaviour before wiring it to the real engine.

The pattern holds one last time: design and mock the logic and UI now, against frozen contracts; slot in the real-time execution when the engine is ready.

---

# The honest summary

These are the features that wait on the hard part. **Stems are mandatory and unremarkable** — do them well, in our register, but don't expect them to differentiate. **Confidence-aware automix and the rehearsal room are where the architecture pays off again** — the honest-grid confidence data and the running-order document let OD-01 do graceful, musical things the incumbents structurally can't, because they don't carry the underlying data or frame prep as a document.

But none of it comes first. The order remains: brand-native trio (`id·2026·014`) and analysis spine now, against the mock; the native engine (`id·2026·009`) as the big lift; these performance features layered on as the engine matures. Build the cheap, distinctive, dependency-free things first — and let the expensive real-time work have clear, mocked targets waiting for it.
