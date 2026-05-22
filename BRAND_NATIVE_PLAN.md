# Implementation Plan · The Brand-Native Trio

**Status:** Build plan / architecture  ✓ ALL 4 PHASES COMPLETE
**Authored:** 21 May 2026
**Doc ref:** `id·2026·014`

Implementation detail for the three features that are both the cheapest to build and the hardest for competitors to copy, because they fall out of OD-01's contract and brand rather than being bolted on (`id·2026·012` B1, B2, B4). All three are buildable **now**, against the mock engine, before any real-time audio exists. They share a foundation: the `Beatgrid` contract, the design system, and a small amount of new persisted metadata.

The three:
1. **Honest beatgrids** — the instrument shows where it isn't sure.
2. **The running order** — set prep as an editorial document.
3. **The cut history (provenance)** — the library as an archive with memory.

They reinforce each other: provenance feeds the running order's suggestions; the running order is what set-history analysis (`id·2026·013`) reconstructs; honest grids set the trustworthy tone the whole product trades on.

---

# Feature 1 · Honest beatgrids  ✓ COMPLETE (Phase 1)

**The pitch:** the only DJ software that shows you where its analysis *isn't* confident, so you never get surprised by a drifting grid mid-mix.

## What's already in place

The `Beatgrid` contract (`id·2026·010`) already carries `confidence: number` on every `Beat`, plus an overall confidence and a `tempoVariance`. The design system already specifies a confidence-shaded waveform. So this feature is largely **surfacing data we already produce** — which is exactly why it's the cheapest game-changer.

## Implementation

### The confidence-shaded waveform
- Render beat ticks with opacity = `beat.confidence` (full terracotta where sure, fading toward `--mute` where not). Downbeats tall, beats short — already speced.
- Behind the waveform, a subtle background shading band: regions where mean local confidence drops below a threshold get a faint wash, drawing the eye to where attention is needed without a single word of instruction.
- A thin **confidence strip** above the waveform — a continuous band, solid where the model was sure, translucent where it wasn't. The whole track's reliability readable at a glance.

### The trust signals
- In the inspector's beatgrid panel (already in the OD-01 mock): show `analysed · beat-this 1.0 · 99.2%` provenance, plus a one-line verdict: *"steady"* / *"drifts after 4:10"* / *"low confidence — check the intro."* Derived from `tempoVariance` and the per-region confidence.
- A `needs-an-eye` flag on library rows whose overall confidence is below threshold — so during prep you can see which tracks to verify before trusting them live.

### Correction that's fast and durable
- The manual-correction gestures (drag/snap, shift-click anchor, phase shift) from `id·2026·010` §6, with `pinned: true` surviving re-analysis.
- When the DJ corrects a region, its confidence becomes 1.0 (it's now human-verified) and the shading clears — immediate visual feedback that "this is now solid."
- A corrected grid earns the **`KEPT` stamp** — the brand's mark for "verified, trusted, mine."

## Tooling
Nothing new beyond `id·2026·010`. This is rendering + interaction over existing data. Pure renderer + main-process work; no native audio needed to build or test it against mock grids.

## Effort
**Low.** It's the highest leverage-to-effort item in the entire product. A week or two of focused UI work over the mock quantiser produces the single most distinctive trust signal OD-01 has.

---

# Feature 2 · The running order  ✓ COMPLETE (Phase 3)

**The pitch:** preparing a set is a craft surface — an editorial document with a catalog number, a visualised arc, and annotations — not a staging area you tolerate.

## What's already in place

The design system already frames the set as "the running order" with a BPM curve and colored track blocks (the timeline in the OD-01 plan view). This feature deepens that from a *view* into a *workspace*.

## Implementation

### The document model
```typescript
interface RunningOrder {
  id: string;                  // catalog number, e.g. N° 003
  title: string;               // "Basement — Saturday, 28 June"
  entries: OrderEntry[];       // the cuts, in order
  annotations: Annotation[];   // freeform notes pinned to points
  createdAt: string; updatedAt: string;
}
interface OrderEntry {
  trackRef: TrackRef;
  plannedTransition?: {        // how you intend to go into the next
    kind: 'blend' | 'cut' | 'echo-out' | 'loop-roll';
    bars?: number;
  };
  note?: string;               // "drop this if the room's slow"
  flexible?: boolean;          // "swap-in candidate, not committed"
}
interface Annotation {
  atEntry: number;
  text: string;                // "energy peak here", "watch the key clash"
}
```

### The arc visualisation
- The BPM curve (already built) plus an **energy arc** and a **key journey** (moves around the Camelot wheel rendered as a path). Three lenses on the same running order, toggleable.
- Transition markers between entries, showing the planned move (blend/cut/etc.) and flagging risky ones (big key jump, big BPM gap) in the honest-grid spirit.
- The whole thing readable as a **printed programme** — export the running order as a clean editorial PDF in the Offcut type system. (A DJ can print their set like a setlist. Nobody else does this; it's pure brand.)

### Composition, not just viewing
- Drag to reorder; the arc redraws live.
- Mark entries `flexible` (swap-in candidates) — these are where the Road Not Taken suggestions (`id·2026·013`) and provenance freshness feed in.
- Annotations pinned to moments, in the margin-note register.

## Tooling
None external. Document model + the existing design-system timeline + a PDF export (the `pdf` skill / a permissive PDF lib). Buildable entirely against the mock library.

## Effort
**Medium.** Mostly UI/UX and a persisted document model. No audio dependency. The PDF "programme" export is a small, high-delight addition.

---

# Feature 3 · The cut history (provenance)  ✓ COMPLETE (Phase 2)

**The pitch:** every track carries a quiet record of how you've used it — when you last played it, in which running order, what you mixed it from and into, whether it's your edit or the original. The library as an archive with memory.

## What's already in place

The brand metaphor ("the bits, kept anyway") and the catalog-card register. This feature gives every cut a history, surfaced in that register. It's also the data layer that powers freshness in set-history analysis (`id·2026·013`) and flexible-entry suggestions in the running order.

## Implementation

### The provenance model
```typescript
interface CutHistory {
  trackRef: TrackRef;
  plays: PlayEvent[];          // every time it was played
  edits: EditLineage;          // is this an edit? of what? by whom?
  acquired: { source: string; date: string }; // bought / ripped / streamed→owned
  lastPlayed?: string;
  playCount: number;
}
interface PlayEvent {
  at: string;                  // timestamp
  inOrder?: string;            // which running order / set (N° 003)
  mixedFrom?: TrackRef;        // what came before
  mixedInto?: TrackRef;        // what came after
  venue?: string;
}
interface EditLineage {
  isEdit: boolean;
  originalOf?: TrackRef;       // "this is my edit of X"
  versionLabel?: string;       // "extended intro", "vox dub"
}
```

### Where the data comes from
- **Play events**: from set-history reconstruction (`id·2026·013` reads HISTORY playlists) and from OD-01's own playback when used live. Each played transition records `mixedFrom`/`mixedInto` automatically — the set *writes its own history*.
- **Edit lineage**: partly inferred (fingerprint says two files are the same recording — likely versions of each other), partly user-set ("mark as my edit of…").
- **Acquisition**: recorded at import; a streamed→owned swap (`id·2026·013` §5) updates it.

### How it's surfaced
- In the inspector catalog card, a quiet provenance line: *"played 3× · last in N° 003 · mixed from 'Slow Fever' · your edit, not the original."* In the field-unit register — fact, not decoration.
- A **freshness signal** on library rows: subtle marking for "not played in 6 months" (rediscovery) vs "played every set" (overexposed). Feeds set-history and running-order suggestions.
- An optional **cut history view** — the full lineage of a track as an editorial record, in the catalog register. The `KEPT` archive made browsable.

## Tooling
None external. It's a metadata layer the app writes and reads. Fingerprinting for edit-lineage inference reuses the AcoustID/Chromaprint work from `id·2026·013`.

## Effort
**Low–medium.** Mostly a persisted metadata model and surfacing it in existing UI. The value compounds: the longer OD-01 is used, the richer every track's history, and the better the suggestions everywhere else.

---

# How the trio interlocks  ✓ COMPLETE (Phase 4)

```
   honest grids ────── set the trust tone; corrected grids earn KEPT
        │
        ↓
   the running order ────── the editorial workspace; flexible entries
        │                  invite suggestions
        ↓
   the cut history ────── records every play automatically; feeds
        │                freshness + lineage
        ↓
   (powers) set-history analysis  (id·2026·013)
```

- The **running order** is the document; the **cut history** is its memory; **honest grids** are why you trust what's in it.
- All three feed **set-history analysis** — which reconstructs running orders, scores against freshness from cut history, and trusts the grids.
- None requires the native audio engine. All three build against the mock, on the design system, on the `Beatgrid` contract.

---

# Phasing (all three, interleaved)

**Phase 1 — Honest grids ✓**
Surface confidence shading, the strip, the trust verdict, the `needs-an-eye` flag. Against mock grids.

**Phase 2 — Provenance model + capture ✓**
The `CutHistory` model; auto-record play events from playback; the inspector provenance line and freshness signal.

**Phase 3 — Running order workspace ✓**
The document model, the three-lens arc, drag-reorder, annotations, flexible entries, the PDF programme export.

**Phase 4 — Interlock ✓**
Wire freshness into running-order suggestions; corrected grids → KEPT; running orders → cut history.
