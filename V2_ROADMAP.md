# Offcut V2 — Full Step-by-Step Roadmap

**Status:** Master plan. No code is to be edited until this is approved.
**Date:** 2026-06-20 · **Branch:** `claude/v2-planning-xu41pc`
**Companion docs:** `V2_PLANNING.md` (direction & decisions),
`V2_PHASE1_FX_PLAN.md` (FX deep-dive). This document is the spine that sequences
everything and is grounded in a read of the actual codebase.

---

## Confirmed direction (from `V2_PLANNING.md`)

1. **Flagship: Performance Pro** — make the booth first-class.
2. **Cloud via Google Drive relay** — no first-party backend; sync + backup, not
   multi-user collab.
3. **Monetization undecided** — keep everything model-agnostic.
4. **HID targets:** Pioneer **XDJ-AZ, XDJ-RX3, CDJ-3000**.

## Dependency map (what gates what)

```
Phase 0 Hardening ──────────────────────────────┐ (gates any user release)
                                                 │
Phase 1 Performance core ─ FX → Sampler → 4-deck │
        (all on the existing master bus)         │
                                                 ▼
Phase 2 Performance reach ─ Ableton Link → Booth polish → HID spike → HID
                                                 │
Phase 3 Cloud (Drive, two-way) ─ serial, after Phase 2
                                                 │
Phase 4 Intelligence ─ embeddings → sound-alike → NL search → AI sets
        (uses Phase 3 to carry vectors across devices)
```

**Resourcing — single track (decided).** Everything runs in one workstream,
engine-first: Phase 0 → 1 → 2 → 3 → 4. Cloud is *capable* of running in parallel
(it's TS/main-process and doesn't touch the Rust engine), so if a second pair of
hands appears later, Phase 3 is the natural parallel track to pull forward — but
the baseline plan does not assume it.

---

## Phase 0 — Harden for scale *(gate; ~1 week)*

Nothing ships to users at scale until these land. From
`AUDIT_AND_COMPLETION_PLAN.md` / `TASKS.md`.

**Steps**
1. **macOS signing + notarization.** Obtain Apple Developer ID; set `identity`
   in `electron-builder.cjs` (currently `identity: null`); wire notarization into
   the release workflow (`.github/workflows/release.yml`). *Blocker — user action
   for the cert.*
2. **Seed the regression net.** `npm test` (Vitest) exists; add audio-core
   regressions for the A1–A9 audit bugs and the engine integration tests that
   currently live ad-hoc under `/tmp` (PLL, synced-seek, keylock coords). Put
   them in `src/main/__tests__` / a Rust integration target so CI runs them.
3. **Audit the rekordbox-usb writer** (PDB/ANLZ). Flagged as the one bug class
   that can brick a gig and never fully audited (`integrations/rekordbox-usb/
   writer.ts`, `pdb-builder.ts`, `anlz.ts`). Gate any USB-export-facing V2 work
   on this.
4. **Windows/Linux hardware pass.** The native engine, MIDI, and output routing
   were verified only on Apple Silicon. Run the real-hardware matrix on Win/Linux
   (the CI already builds them per `PACKAGING.md`).

**Exit criteria:** signed/notarized Mac build auto-updates; CI runs the audio
regression suite green on all three platforms; USB writer has a sign-off.

---

## Phase 1 — Performance Pro core *(flagship; ~5–6 weeks)*

All three items compose on the V1 master-bus engine (`output.rs`: one cpal
stream renders every registered `DeckEngine` via a `DeckRenderer`).

### 1A · Per-deck FX chain *(~13 d — see `V2_PHASE1_FX_PLAN.md`)*

Summary of that plan: filter + delay **already exist and are wired end-to-end**
(`filter.rs`, `apply_delay`, `set_filter`/`set_delay`) but are driven only by
`automixStore`. Work *(decided: 3 slots, user-reorderable)*:
1. `Effect` trait + a 3-slot `FxChain` whose **order is user-controlled**, in a
   new `native/audio-engine/src/fx/`, with off-thread construction + `ArcSwap`
   handover (no alloc in the callback). The channel fader is a **reference point
   in the chain order** — slots before it are pre-fader inserts, slots after it
   are post-fader sends — so echo placed last still "rings out" as the fader
   drops, while staying fully reorderable. (See `V2_PHASE1_FX_PLAN.md` §2.2.)
2. Migrate filter + delay into slots; keep `set_filter`/`set_delay` as shims.
3. `set_fx_slot` napi + full wiring spine (IPC → preload → contract →
   `nativeAudioEngine`; Web-Audio no-op stub).
4. New modules: reverb → flanger → phaser → bitcrush → gate → noise → roll.
5. `fxStore` + per-deck FX rack UI; FX presets table via `schema.ts` migration.
6. Repoint `automixStore` onto the slot path; Rust unit + integration tests.

**First shippable slice:** abstraction + the two existing effects surfaced as a
manual rack (hands-on filter + echo) before any new DSP.

### 1B · Sampler decks *(~2 weeks)*

The master bus already renders N registered `DeckEngine`s
(`lib.rs:publish_active_decks`, `active: ArcSwap<Vec<Arc<DeckEngine>>>`), so a
sampler is **new sources registered into the same `active` list** — not a new
architecture.

**Steps** *(decided: dedicated `SamplePlayer`)*
1. **Engine: a dedicated `SamplePlayer` renderer** registered into `active`
   alongside the decks (purpose-built, not a repurposed `DeckEngine`). It holds N
   pad voices, each with a loaded sample, a mode (one-shot / loop / gate =
   play-while-held), per-pad gain, and quantize-to-master-beat triggering. Its
   own `Renderer` sums its active voices into the master like a deck does. More
   engine code than reusing `DeckEngine`, but clean polyphony and pad semantics.
2. **napi:** `create_sample_bank(bankId)` / `trigger_pad(pad, mode)` /
   `set_pad_gain` — mirror `create_deck`.
3. **Wiring spine:** IPC → preload → contract → a `samplerEngine` binding.
4. **Store + UI:** an 8-pad sampler panel (one-shot, loop, gate, per-pad gain,
   quantize-to-grid using the existing beat clock). Pads load from the library
   or a samples folder.
5. **Persistence:** sample-bank assignments in the library DB (migration).
6. **Tests:** trigger timing (quantized to master beat), one-shot vs gate,
   polyphony bound.

**Exit criteria:** 8 pads trigger sample-accurately against the master clock,
recorded into the existing master tap, with no callback allocation.

### 1C · Four-deck mode *(~1.5 weeks — mostly renderer)*

The engine is **already N-deck** (the callback iterates all registered decks).
The constraint is purely renderer-side: `playerStore.ts` hardcodes two stores
(`createDeckStore('A')`, `('B')`, `usePlayerStore = useDeckAStore`) and sync
hardcodes the partner (`masterId = deckId === 'A' ? 'B' : 'A'`).

**Steps**
1. **Generalize deck stores** to a deck-id set `{A,B,C,D}`; replace the binary
   A/B sync-partner logic with an explicit master selector (any deck can sync to
   any other — the engine already supports arbitrary `syncTo`).
2. **Mixer/UI** for 4 channels: 4 faders, EQ/FX strips, and a crossfader
   assignment model (which decks are on which side). The mix-bus gain staging
   (`lib/mixBus.ts`) generalizes from 2 to N.
3. **Layout:** a 2-deck vs 4-deck view toggle (don't force 4 decks on small
   screens).
4. **Tests:** N-deck sync matrix (C synced to A while B free-runs), gain staging
   across 4 channels.

**Exit criteria:** four independent decks play, sync any-to-any, and mix through
one master with correct gain staging and recording.

**Phase 1 gate:** a DJ can run a 4-deck set with manual FX and a sampler,
recorded to WAV, entirely in Offcut.

---

## Phase 2 — Performance Pro reach *(~5–7 weeks, HID-dependent)*

### 2A · Ableton Link *(~2 weeks)*

No Link crate is present yet (`Cargo.toml` has cpal/symphonia/rubato/arc-swap,
no link). The shared master sample clock exists, which is the hard prerequisite.

**Steps**
1. **Add the `rusty_link` crate** (Rust bindings to Ableton Link) to the engine.
2. **Bridge Link ↔ master clock:** read Link's beat time/tempo in (or alongside)
   the master callback; expose `enable_link`, `set_link_tempo`, and a
   "sync deck to Link" mode that feeds the existing PLL (`output.rs` sync) a
   Link-derived phase target instead of a master deck.
3. **Wiring spine + UI:** a Link toggle + peer count + tempo readout.
4. **Tests:** tempo/phase agreement with a second Link peer within the PLL
   deadband; graceful enable/disable.

**Exit criteria:** Offcut locks tempo+phase to another Link app within the
existing sync tolerance.

### 2B · Booth polish backlog *(~1.5 weeks)*

Small, universally-expected items from `DJ_SOFTWARE_AUDIT.md`, cheap on the new
engine: beat jump (±1/2/4/8/16/32), quantize mode, slip/flux finalization, loop
roll, saved-loop slots, pre-listen device routing, pitch-range selector,
Open-Key notation toggle. Each is a small wiring-spine + UI task; batch them.

### 2C · HID controllers — **feasibility spike first** *(spike ~1 week, then scoped)*

⚠️ **Honesty flag.** The three targets are **standalone players/all-in-ones, not
conventional MIDI/HID controllers**, so this is the highest-uncertainty work in
V2 and must start with research, not code:

- **CDJ-3000** is controlled over **ProLink (Ethernet)**, which Offcut *already
  speaks* (`integrations/prolink`, ProLink B2B capture). Integration here likely
  flows through the **existing ProLink path** (read play state / load tracks /
  status) rather than USB HID. Confirm what control (vs. monitoring) ProLink
  permits.
- **XDJ-RX3 / XDJ-AZ** are standalone units. Whether they can act as **HID
  controllers for third-party software** (vs. rekordbox-only / standalone) is
  *uncertain and must be verified on real hardware* before committing.

**Steps**
1. **Protocol spike (no product code):** with each unit on the bench, capture
   what it exposes — USB HID descriptors, MIDI (XDJs have a MIDI mode in some
   firmwares), and what ProLink offers for the CDJ-3000. Produce a one-page
   feasibility finding per unit: *controllable? via what? read-only or
   bidirectional?*
2. **Decide the integration surface** from the spike: native USB HID (Node
   `node-hid` in main, or a Rust HID module in the engine), MIDI (extend the
   existing `midiEngine.ts`), or ProLink control. Keep the existing MIDI-learn
   model; HID maps onto the same deck/FX/slot action model (the FX slot params
   were kept flat/numeric for exactly this).
3. **Implement per confirmed surface**, unit by unit, with LED/jog feedback where
   the protocol allows.
4. **Real-hardware test matrix** per unit.

**Exit criteria:** documented, per-unit decision; then working transport + FX
control for whichever units the spike proves controllable. *Scope and effort for
the implementation are deliberately not fixed until the spike returns.*

---

## Phase 3 — Offcut Cloud (Google Drive, two-way) *(~4–5 weeks; parallelizable)*

**Already built (one-way, for mobile):** `cloud/manifest.ts` diffs desired vs.
published audio (content-hash `proxyCacheKey` keys each proxy) and publishes a
`library.json` snapshot + proxies to a private Drive folder; the phone reads it.
The library sync engine also exists: `library/sync.ts`, `library/apply-push.ts`,
`library/content-hash.ts`, and the LAN `/sync/pull|push` server (`sync/server.ts`).

**V2 turns this one-way publish into two-way, multi-machine sync.**

**Steps**
1. **Desktop Drive auth/linking.** OAuth a user's own Drive on the *desktop*
   (today the desktop publishes; we need a real linked account + a stable
   per-user app folder). Reuse the existing transport that `manifest.ts` injects.
2. **Two-way sync model.** Generalize `planPublish`/`applyUploads` and the
   mobile `apply-push` into a **device-peer mirror**: each machine pulls the
   remote snapshot, three-way-merges against its local library + last-synced
   base, and pushes its changes. Reuse `content-hash.ts` to detect real changes.
3. **Conflict resolution.** Decide the model (open question below) — recommend
   **field-level last-writer-wins** with a per-field `updatedAt`, since the
   schema already tracks edit times and the audit hardened the re-import merge to
   not clobber local edits (`library.ts`). Surface conflicts the user must judge.
4. **File locker (opt-in).** Extend the proxy publish to optionally sync full
   audio (not just AAC proxies) so a fresh machine is gig-ready; gate by size +
   user opt-in (the plan already computes `uploadBytes`).
5. **Backup / restore.** One-click "snapshot my whole setup to Drive" and
   "restore on this machine" (builds on `main/backup/`).
6. **UI:** a Cloud settings page (link Drive, sync status, conflicts, locker
   toggle, storage estimate). Mirror the existing PhoneSync panel patterns.
7. **Tests:** the diff/merge logic is pure and unit-testable (as `manifest.ts`
   already is) — cover two-device edit/merge, conflict, delete-propagation,
   resumed-after-failure.

**Explicitly out (needs a backend):** cross-account shared crates / live
collaboration. Note as future.

**Exit criteria:** edit on laptop → appears on desktop after sync, with
conflicts surfaced, and a fresh machine restores a gig-ready library from Drive.

---

## Phase 4 — Intelligence Layer *(~5–6 weeks)*

**Already present:** `onnxruntime-node` runs the beat model in the main process
(`beat-analysis/beat-model.ts`, `InferenceSession`); the **consumer side** of
embeddings already exists (`roadNotTaken.ts` and `similarity.ts` carry
`embedding?: number[]` and `audioSimilarity()`), explicitly tagged *"v1 — no
audio embeddings yet."* The AI client has model tiers + spend guard
(`integrations/ai/{client,usage}.ts`, opus/sonnet/haiku, monthly cap).
**Only the embedding generator is missing.**

**Steps**
1. **Audio-embedding generator.** Add an ONNX embedding model + an analysis pass
   (sibling to the beat pass) that writes a per-track vector to the library DB
   (new column/table via migration). Decode reuse: the analysis pipeline already
   decodes audio. Keep it **local/ONNX (free)** — no per-track cloud cost.
   - Sub-decision: which embedding model (open-source music tagger / CLAP-style).
     Verify model availability before fixing.
2. **Backfill + incremental.** Generate embeddings for the existing library
   (batch, resumable) and on import (hook the watch-folder analyse path).
3. **Sound-alike search.** Wire the now-populated `embedding` field into the
   existing `audioSimilarity()` path so `roadNotTaken.ts` and the `TrackDetail`
   SOUND mode return real content neighbours, not metadata-only. Add a kNN index
   if the library is large.
4. **Natural-language search.** The AI client already references "NL search" and
   has a cheap-model tier (`AI_CHEAP_MODEL = haiku`). Build a query → structured
   filter (BPM/key/energy/tags) + embedding-retrieval pipeline; combine with the
   analysed metadata and lineage graph as context. Respect the existing spend
   guard (`usage.ts` cap).
5. **AI crate / set generation.** Feed the Set Builder arc model
   (`SetBuilder/model.ts`, BPM/Energy/Key arcs) candidate paths from AI +
   embeddings; human edits the result. Reuse the spend guard.
6. **Smart auto-tagging (optional).** Propose genre/mood/vibe tags for untagged
   imports from embeddings + AI, feeding the categorized-tag model.
7. **Tests:** embedding determinism/shape, kNN correctness on a seeded set, NL
   query → filter mapping, spend-guard enforcement.

**Exit criteria:** "tracks that *sound* like this" returns content-based
neighbours; an NL query returns a sensible filtered set; AI proposes a
harmonically-coherent set the user can edit — all within the spend cap.

---

## Milestones & sequencing

| Milestone | Contents | Rough window |
|---|---|---|
| **M0 — Ship-ready** | Phase 0 complete | Week 1 |
| **M1 — Booth FX** | 1A first slice (manual filter+echo rack) | Weeks 2–3 |
| **M2 — Full FX** | 1A complete (all effects) | Weeks 4–5 |
| **M3 — Sampler + 4-deck** | 1B + 1C | Weeks 6–8 |
| **M4 — Link + polish** | 2A + 2B | Weeks 9–11 |
| **M5 — HID** | 2C spike → scoped implementation | Weeks 11+ (spike-gated) |
| **M6 — Cloud** | Phase 3 (Drive two-way) | After M5, ~4–5 weeks |
| **M7 — Intel** | Phase 4 | After M6, ~5–6 weeks |

*Single-track, engine-first: phases run in sequence. HID (M5) is deliberately
open until the spike returns, which may shift everything after it. If a second
pair of hands appears, Cloud (M6) is the track to pull forward in parallel.*

---

## Cross-cutting principles (apply to every phase)

- **Real-time safety is absolute** in the audio callback (`output.rs`:
  "no mutex, no allocation, no syscall"). All construction off-thread; hand over
  via `ArcSwap`; reuse the `ANTI_DENORMAL` pattern in feedback DSP.
- **Every engine feature travels the same wiring spine:** Rust atomics → napi →
  `engine/index.ts` IPC → `preload` → `audioEngineContract.ts` →
  `nativeAudioEngine.ts` (+ honest Web-Audio no-op stub) → store → UI.
- **Honest degradation:** features that need the native engine disable with a
  tooltip under Web Audio (the KEY/SYNC/REC pattern already in place).
- **Migrations stay strict** (only swallow "duplicate column", per the audit).
- **Model-agnostic monetization:** no feature hard-coupled to a paywall.
- **Match the test bar:** Rust unit + integration, Vitest on the TS side; pure
  modules (diff/merge, planners) stay pure and unit-tested.

---

## Resolved decisions (2026-06-20)

1. **FX rack:** ✅ **3 slots, user-reorderable.** Order is user-controlled with
   the channel fader as a reference point in the chain (pre-fader inserts before
   it, post-fader sends after) so echo still rings out. *(detail in
   `V2_PHASE1_FX_PLAN.md` §2.2)*
2. **Sampler:** ✅ **dedicated `SamplePlayer`** renderer (not a repurposed
   `DeckEngine`).
3. **4-deck sync:** ✅ **any-to-any master selector** (matches the engine's
   arbitrary `syncTo`).
4. **HID:** ✅ **feasibility spike first**, scope set only after; CDJ-3000 likely
   via ProLink, not HID.
5. **Cloud conflict model:** ✅ **field-level last-writer-wins** (per-field
   `updatedAt`); **locker syncs proxies first**, full-audio later.
6. **Embeddings:** ✅ **local-only ONNX** (zero per-track cost; model TBD after
   verifying availability).
7. **Resourcing:** ✅ **single track, engine-first** (Cloud serial after Phase 2).

### Still genuinely open (resolve in-phase, not blocking)

- **Embedding model choice** — pick the specific open ONNX music model when
  Phase 4 starts (verify availability/licence then).
- **HID scope/effort** — undefined by design until the 2C spike returns.
- **Master FX send** — deferred; revisit after the per-deck rack ships.

*Next artifact: per-phase task tickets. Still no code until you say go.*
