# Offcut V2 — Planning & Direction

**Status:** Brainstorm / direction-setting. Opened after the V1 (0.1.x) release.
**Date:** 2026-06-20
**Purpose:** Decide what V2 *is* — a coherent theme, not a feature pile — and
sequence the work behind it.

---

## Where V1 landed

V1 is, surprisingly, a *complete* product across three layers:

- **Library manager** — two-way sync with Rekordbox (XML + master.db + USB),
  Serato, Traktor, Engine DJ, Apple Music, VirtualDJ; smart playlists, Smart
  Fixes, watch folders, tag write-back. This is best-in-class breadth.
- **Performance app** — native Rust audio engine (single master-bus
  architecture, PLL sync, keylock via Signalsmith, real stems, recording,
  limiter), beatgrid/cue editing, MIDI mapping, ML analysis (Beat This! ONNX +
  key/energy/mood/danceability).
- **Companion + intelligence** — mobile app (LAN/cloud audition), Lineage
  (track genealogy graph), Set History, ProLink B2B capture, Set Builder, the
  Compass scatter-map.

The differentiators **no competitor has** — Lineage, Cut history, Running
orders, the BPM-arc Set Builder, ProLink B2B capture — are all *knowledge and
context* features, not deck features. **That is the strategic identity to
lean into for V2.** Offcut is the DJ's *brain and memory*, not just another
pair of decks.

### V1 loose ends that gate V2 (close these first)

These are tracked in `TASKS.md` / `AUDIT_AND_COMPLETION_PLAN.md` and several
are hard blockers for anything we ship to users at scale:

1. **macOS signing / notarization** — still `identity: null` while auto-update
   is configured. *Cannot ship a real V2 to Mac users without this.* (Needs an
   Apple Developer ID — user action.)
2. **No JS test runner seeded** — `npm test` runs Vitest but the audit asks for
   regression coverage on the audio core (A1–A9). V2 will move fast; we need
   the net first.
3. **Uncovered subsystem audit** — the rekordbox-usb **writer** (PDB/ANLZ) was
   flagged as the one bug class that can brick a gig and was never fully
   audited. Gate any USB-export-facing V2 work on this.
4. **Real-hardware matrix** — CDJ USB export, ProLink capture, MIDI controllers,
   output routing were verified only on Apple Silicon. Windows/Linux parity is
   unproven.

---

## V2 thesis

> **V1 made Offcut a complete *library and prep* tool that could also play.
> V2 makes the booth a first-class citizen — Offcut becomes a real
> instrument — and then makes that collection *networked and intelligent*.**

Three pillars, in priority order. **Pillar A (Performance Pro) is the
flagship** — confirmed direction. Cloud and Intelligence follow and compound on
the same engine work.

---

## Pillar A — Performance Pro (the flagship) ★

**Direction confirmed:** the booth leads V2. The master-bus engine that landed
in V1 (`native/audio-engine/`, single duplex stream, shared clock, limiter,
recording tap) was the hard part — it *unblocks* the performance features that
were previously impossible. V2 turns Offcut from "a library manager that can
play" into a tool a DJ trusts on a real rig.

What it unlocks (all hosted on the existing master bus):

- **Per-deck FX chain** — reverb / delay / echo / filter / flanger, in the Rust
  engine. The audit scoped this at ~3d; the master bus now exists to host it,
  and the limiter already protects the summed output.
- **Sampler decks** — 8-pad one-shot / loop sampler rendered through the master
  bus and captured by the existing recording tap.
- **Four-deck mode** — the master bus already renders *N* registered
  `DeckRenderer`s; the work is UI + routing, not new DSP architecture.
- **Ableton Link** — sync Offcut's tempo to other Link apps and gear. Natural
  now that there's one shared sample clock to drive it (`Cargo.lock` already
  shows scaffolding in `lib.rs`); a growing live-performance standard.
- **HID controller support** — native USB HID for Pioneer / Rane / Denon gear
  with LED + jog-wheel feedback, so Offcut *drives* real hardware rather than
  only MIDI-learn. (Audit's biggest single-effort item; do after FX/Link.)
- **Booth polish from the audit backlog** — beat jump, quantize, slip/flux
  finalization, loop roll, saved-loop slots, pre-listen device routing,
  pitch-range selector. Small, universally-expected, cheap on the new engine.

**Sequencing:** FX chain → sampler → 4-deck → Ableton Link → booth polish →
HID (heaviest, platform-specific). FX and the sampler share an effects-graph
abstraction in the engine — build that once.

**Risk to manage:** this pillar is partly *parity-chasing*. Keep the bar at
"trustworthy on a real rig," and resist the long tail (DVS/timecode vinyl,
broadcasting) that turns Offcut into "another Serato" instead of the DJ's brain.
The differentiation still lives in Pillars B and C — Performance Pro earns the
right to be *in the booth at all*, where the knowledge features then shine.

---

## Pillar B — Offcut Cloud (the platform layer)

**Architecture decided: Google Drive relay (no first-party backend for now).**
A first-party backend is an expensive surface to build and *own* — auth,
hosting, storage, and the privacy of a user's whole collection. For V2 we
extend the **existing Google Drive route** (already used by the mobile
companion; `src/main/cloud/manifest.ts` is the seed) so storage lives in the
user's own Drive and we stay out of the storage/hosting business. Revisit a
first-party backend only if collaboration demand clearly outgrows the relay.

**Trade-off to accept:** Drive-relay is excellent for **sync and backup** (each
user's own Drive), but **multi-user sharing/collaboration is constrained** —
cross-account shared crates are awkward over personal Drive folders. So for V2,
Cloud = *cross-device sync + locker + backup*; the richer B2B collaboration
ideas move to "future" until a backend is justified.

Biggest gap vs Rekordbox Cloud / Engine Cloud. What it unlocks:

- **Cross-device library sync** — real account, not just the mobile LAN relay.
  Crates, cues, grids, tags, ratings, lineage, and set history mirror between
  laptop, studio desktop, and phone. Conflict resolution on the already-
  normalized library schema that powers import/export.
- **Audio locker (opt-in)** — sync files (or analysed proxies) so a fresh
  machine is gig-ready. Parity with Rekordbox CloudDirectPlay.
- **Shared crates & collaborative playlists** — co-curate a B2B set before the
  gig. Offcut's edge: you share *why* (lineage, notes, running order), not just
  a track list. This is also where Performance Pro and Cloud meet — a shared
  B2B crate that drives a 4-deck booth session.
- **Gig backup / restore** — one-click "restore my setup on this machine."

**Sequencing:** Drive auth/linking → schema-level metadata sync (mirror, with
conflict resolution) → file locker (opt-in) → backup/restore. Each stage is
independently useful and reuses the library normalization already powering
import/export. Collaboration is explicitly out of scope until a backend exists.

**Note:** monetization is *undecided* — plan features to work under either a
one-time or subscription model and don't hard-couple anything to a paywall. The
Drive-relay choice means cloud has low ongoing cost to us (storage is the
user's Drive), which keeps a one-time model viable if we want it.

---

## Pillar C — The Intelligence Layer (lean into the differentiator)

**Why now:** Offcut already ships ML analysis and the *consumer* UI for
sound-alike search exists (`TrackDetail` SOUND mode) — but
`roadNotTaken.ts` flatly notes **"no audio embeddings yet"**; today similarity
is metadata-only. Building the embedding pass is the unlock for a whole class
of features competitors can't match because they don't have the graph.

- **Audio embeddings → true sound-alike search.** An ONNX embedding pass in the
  main process (sibling to the existing Beat This! analysis pipeline) writes a
  per-track vector. Powers "tracks that *sound* like this," not just "same BPM
  and key." This is the missing primitive behind Tier-3 mobile features too.
- **Natural-language library search.** "Find a dark, rolling 174 roller that
  mixes harmonically out of [track]." The `@anthropic-ai/sdk` is already a
  dependency (used by Lineage AI). Combine embeddings + the analysed metadata +
  the lineage graph as retrieval context.
- **AI crate / set generation.** Generate a harmonically-coherent set with a
  target energy arc — the Set Builder's BPM/Energy/Key arc model already exists
  (`SetBuilder/model.ts`); AI proposes the *path*, the human edits it.
- **Smart auto-tagging.** Use embeddings + AI to propose genre/mood/vibe tags
  for untagged imports, feeding the categorized-tag model the mobile roadmap
  wants.

**Sequencing:** embedding generator first (it's the shared dependency), then
sound-alike, then NL search, then generative set/crate building.

**Risk to manage:** AI spend. The Lineage work already added an "AI spend
guard" (`afa3411`) — reuse that guardrail; keep embeddings local/ONNX (free),
keep cloud LLM calls bounded and opt-in.

---

## Recommended V2 shape

Re-sequenced for the confirmed direction: **Performance Pro leads.** Cloud is a
lighter track now (Drive relay, no backend to build/own), so it can slot in
after the flagship rather than running as a long-lead parallel build.

1. **Phase 0 — harden for scale:** signing/notarization, regression test net,
   rekordbox-usb writer audit, Windows/Linux hardware pass. *(gates everything;
   doubly important now that the booth is the headline)*
2. **Phase 1 — Performance Pro core:** effects-graph abstraction → per-deck FX →
   sampler → 4-deck mode. *(the flagship; all on the existing master bus)*
3. **Phase 2 — Performance Pro reach:** Ableton Link + booth-polish backlog
   (beat jump, quantize, slip, loop roll, pre-listen routing) → HID last.
4. **Phase 3 — Offcut Cloud (Drive relay):** Drive linking → metadata sync →
   file locker → backup/restore. *(sync + backup, not collaboration.)*
5. **Phase 4 — Intelligence:** audio embeddings → sound-alike → NL search → AI
   set building. *(the moat; reuses Cloud to carry vectors across devices.)*

**One-line pitch for V2:** *"Trusted in the booth — your whole collection,
everywhere, finally understanding itself."*

---

## Confirmed decisions (2026-06-20)

- **Flagship:** ✅ **Performance Pro** leads V2 (the booth becomes first-class).
- **Cloud architecture:** ✅ **Google Drive relay** — extend the existing route;
  no first-party backend for now (too expensive to build and own). Trade-off:
  cloud is sync + backup, not multi-user collaboration, until a backend exists.
- **Monetization:** ⏳ **undecided** — plan all features to work under either a
  one-time or subscription model; do not hard-couple anything to a paywall. The
  Drive-relay choice keeps ongoing cost low, so a one-time model stays viable.

## Still open

- **Scope discipline on Performance Pro:** where's the line? Recommend stopping
  at "trustworthy on a real rig" (FX, sampler, 4-deck, Link, HID) and excluding
  the long tail (DVS/timecode, broadcasting) so the "DJ's brain" identity isn't
  diluted. Confirm the cut.
- **HID hardware scope:** ✅ **target Pioneer XDJ-AZ, XDJ-RX3, CDJ-3000 first.**
  All Pioneer/AlphaTheta, so one HID protocol family (Pioneer's HID/MIDI hybrid)
  covers the set; the two all-in-ones (AZ, RX3) plus the flagship player. Phase 2
  work; informs the test-hardware list. *(Detailed plan TBD when Phase 2 starts.)*
- **Drive sync conflict model:** last-writer-wins vs field-level merge for the
  metadata mirror — matters once the same library is edited on two machines.

*See `DJ_SOFTWARE_AUDIT.md` for the full competitive matrix and `TASKS.md` for
the V1 backlog this builds on.*
