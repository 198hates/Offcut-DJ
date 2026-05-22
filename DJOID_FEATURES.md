# Djoid Feature Parity Plan

Reference: full audit of Djoid (docs.djoid.io, djoid.io/feature/*, user guide, comparison articles, set-prep blogs).
Last updated: 2026-05-21

---

## Already Implemented ✓

| Feature | Status | Notes |
|---------|--------|-------|
| BPM + Key analysis | ✓ | analyzerWorker (JS) + Beat This! ONNX |
| Energy (1–10) | ✓ | Schema, analysis, UI |
| Danceability (0–1) | ✓ | Beat regularity + attack sharpness in analyzerWorker |
| Genre field | ✓ | Text field + normalisation Smart Fix (manual, not audio-detected) |
| Chapter / Set Builder | ✓ | Split / Swimlane / Timeline views + intelligence layer |
| Magic Sort (per chapter) | ✓ | Greedy nearest-neighbour by compatibility score |
| Seed suggestions | ✓ | Set Builder suggestion panel |
| Arc health indicators | ✓ | Coloured dots between chapters |
| Matching Tracks panel | ✓ | TrackDetail "04 mixable tracks" — missing Next Mode |
| Auto-Group | ✓ | DBSCAN clustering in LibraryHealth |
| Auto-Cue generation | ✓ | LibraryHealth batch + TrackDetail button (Mix In / Drop / Break / Outro) |
| Beatgrid editor | ✓ | Inline GRID panel in player with TAP / SET BEAT HERE / AUTO (Beat This!) |
| Smart Playlists | ✓ | 14-field rule builder |
| Custom metadata fields | ✓ | Arbitrary key-value custom tags per track |
| VirtualDJ export | ✓ | Writer + Sync page |
| Duplicate detection | ✓ | LibraryHealth section 04 |
| Missing file recovery | ✓ | LibraryHealth section 05 + Auto-Locate |
| Write tags to file | ✓ | IPC handler + TrackDetail button |
| M3U / CSV export | ✓ | Sidebar right-click on any playlist |
| Watch folders | ✓ | Settings page |
| Path mappings | ✓ | Settings page |
| Play history + stats | ✓ | LibraryHealth section 07 |

---

## Phase 1 — Emotion / Mood Dimension  🔴 CURRENT

**Djoid says:** *"Captures the mood a track evokes — whether euphoric, melancholic, or anything in between."*
Mood is treated as a first-class axis alongside energy and danceability. It powers the graph edges, chapter arc health, and Next Mode weighting.

### What "fullest potential" means here
- `mood` stored as a float (−1.0 → +1.0) in the DB: dark/tense on the left, bright/euphoric on the right
- Auto-detected from audio in the existing analyzerWorker — no extra model needed
- Categorical label derived from the numeric value (Dark / Melancholic / Neutral / Uplifting / Euphoric)
- Visible everywhere: TrackDetail, Library column, TrackBrowserPanel in Set Builder, Mixable Tracks panel
- Feeds into: compatibility score, auto-group weights, magic sort, arc health, suggestion scoring, Smart Playlist rules
- FN-BUS filter chip for mood category
- All integration readers initialise `mood: null`

### Detection algorithm
In `analyzerWorker.ts`, a new `detectMood()` function uses features already computed as by-products of BPM/key detection:

```
spectralBrightness = energy_above_2kHz / total_energy   (high = bright = positive)
bassWeight        = energy_below_200Hz / total_energy   (high = heavy bass = negative)
keyModeBonus      = major key → +0.20, minor → −0.15
```

`rawValence = spectralBrightness − (bassWeight × 0.6) + keyModeBonus`
Normalise to [−1, 1] and clip.

This is not perfect — heavy techno in a major key will score oddly — but it produces consistent relative rankings within a library. DJs can override manually.

### Scale labels

| Score | Label | Examples |
|-------|-------|---------|
| −1.0 → −0.6 | Dark | heavy techno, industrial, dark ambient |
| −0.6 → −0.2 | Melancholic | minor-key house, late-night deep |
| −0.2 → +0.2 | Neutral | functional peak-time, groove-focused |
| +0.2 → +0.6 | Uplifting | melodic house, progressive, anthemic |
| +0.6 → +1.0 | Euphoric | hands-in-the-air, major-key trance/house |

### Files to change
- `src/shared/types.ts` — `mood: number | null` on Track
- `src/main/library/schema.ts` — migration: `ALTER TABLE tracks ADD COLUMN mood REAL`
- `src/main/library/db.ts` — `rowToTrack`: `mood: row.mood ?? null`
- `src/main/library/smart-playlist.ts` — `mood` field support
- `src/main/ipc/library.ts` — `COL_MAP` + `'mood'` in `SmartRuleField`
- `src/renderer/src/lib/analyzerWorker.ts` — `detectMood()` + include in result
- `src/renderer/src/lib/analyzer.ts` — `mood` in `AnalyzerResult`
- `src/renderer/src/lib/compatibility.ts` — weight mood in `compatibilityScore()`
- `src/renderer/src/components/TrackDetail.tsx` — mood bar in inspector + edit tab
- `src/renderer/src/pages/Library/index.tsx` — mood column
- `src/renderer/src/pages/SetBuilder/index.tsx` — mood in `computeProfile()`, `fitScore()`, arc health
- `src/renderer/src/components/FnBus.tsx` — mood filter chips
- All 6 integration readers + watch-folder — `mood: null`

---

## Phase 2 — Scatter Map (Library Compass page)  🔵 NEXT

**Djoid says:** *"Plots every track in your library as a point in 2D space based on musical characteristics. Distance equals difference, proximity equals compatibility."*
Djoid also has a visual "Record Grid" — a tile view of tracks by cover art. The Scatter Map is the spatial/analytical version.

### What "fullest potential" means here
- New nav section "Compass" (telescope or compass icon)
- Canvas-based 2D scatter plot — the same canvas infrastructure already used in WaveformGL
- Default axes: X = danceability, Y = energy. Switchable: X = mood, Y = energy; X = BPM, Y = energy
- Dot colour: Camelot key colour (reuse existing colour map) OR genre colour. Switchable toggle.
- Dot size: proportional to rating (1–5) or uniform
- Dot opacity: full = fully analysed; semi-transparent = missing fields
- Zoom: scroll wheel to zoom in/out (pivot on cursor); pan with drag
- Hover tooltip: album art thumbnail + title, artist, BPM, key, energy, mood label
- Click: opens TrackDetail side panel
- Lasso select: drag to draw a freehand region → selected dots highlight → "Add N to Set Builder" or "Create Playlist" button appears
- Filter sidebar: genre chips, key chips (Camelot), mood category buttons → non-matching dots dim to 10% opacity
- "Cluster outlines": after Auto-Group is run, draw soft convex-hull shapes around each auto-group cluster
- Empty / no-data dots: shown as small hollow circles with tooltip "Needs analysis"

### Technical approach
- No UMAP/t-SNE needed for default axes (they map directly to X/Y)
- For a "similarity" scatter (like Djoid's true scatter map), optionally run UMAP in a Web Worker on the feature vector `[bpm_norm, energy_norm, camelot_pos, danceability, mood]` to get 2D coords. Store as `tracks.scatter_x`, `tracks.scatter_y`.
- Canvas render: each dot is 6px at 1× zoom, scales with zoom. Use quadtree for efficient hit-testing on hover.

---

## Phase 3 — Graph View in Set Builder (4th view mode)  🟡 PLANNED

**Djoid says:** *"Every 2 tracks you connect have a relationship. Once connected, they call tracks that share a similar nature."* The Graph Selector rings current selections with compatible candidates — hover to pre-listen, click to add.

### What "fullest potential" means here
- 4th view mode tab: Graph (alongside Split / Swimlane / Timeline)
- Canvas force-directed layout:
  - **Anchored nodes** (tracks in the active chapter): dark filled circles, labelled, fixed positions
  - **Candidate ring** (compatible library tracks not yet added): lighter circles floating around anchors, distance from anchor = inverse compatibility score
  - **Edges** between anchored nodes: coloured by match type (green = harmonic, orange = BPM-only, blue = mood/energy match); edge thickness = score
- Hover candidate: expanded card showing BPM, key, energy, mood + 8-bar audio preview clip
- Click candidate: add to chapter → becomes an anchor → graph re-runs layout → new candidates surface
- Right-click: "Add to chapter" | "Open in detail" | "Dismiss" (hides from candidates permanently)
- Chapter tab strip at top: switch between chapters; each chapter has its own graph
- Empty chapter state: "Add 1–2 seed tracks to start exploring"
- Physics: simple spring-repulsion (Coulomb + Hooke), settles in ~300ms, re-runs on each add
- Candidate pool: top 30 tracks from library by compatibility to the chapter's centroid profile

---

## Phase 4 — Matching Tracks: Next Mode  🟡 PLANNED

**Djoid says:** *"Next Mode — designed for flow. Finds the perfect track following the last one in your playlist. Weights recent tracks more heavily."*

### What "fullest potential" means here
- Toggle in the Mixable Tracks panel header: "MATCH" | "NEXT" buttons
- **Next mode scoring:**
  ```
  score = camelotScore × 0.30
        + bpmScore     × 0.25
        + energyContinuity × 0.20   // reward ±1.5 energy of last track
        + moodContinuity   × 0.15   // reward continuing the mood direction
        + momentumScore    × 0.10   // small reward if slightly higher energy (building)
  ```
- Context source: last 3 tracks from active Set Builder chapter OR deck play history
- Show which factors drove the score (e.g. "harmonic ✓  energy +1  mood →")
- "Why" tooltip on each suggestion explaining the top scoring factors

---

## Phase 5 — Advanced Multi-Dimension Search  🟡 PLANNED

**Djoid says:** *"Filter across all attributes simultaneously: genre, BPM range, energy levels, danceability, mood, release date."*

### What "fullest potential" means here
- Accessible from nav rail (magnifying glass / "Search" section)
- Five range controls with live result updating:
  - BPM: dual-handle range slider (40–200)
  - Energy: dual-handle range slider (1–10)
  - Danceability: dual-handle range slider (0–1)
  - Mood: dual-handle range slider (−1 dark → +1 euphoric) + category chips
  - Key: Camelot wheel multi-select
- Filter chips: Genre (multi-select), Tags (multi-select), Has BPM / Has Cues / Has Beatgrid
- Result count shown as slider moves (e.g. "312 tracks match")
- Result list: same TrackRow as Library page with all columns
- "Send N to Set Builder" → adds all matching to active chapter
- "Save as Smart Playlist" → auto-generates rule set from current slider positions
- ⌘F keyboard shortcut to focus

---

## Phase 6 — Genre Detection from Audio  🔵 STRETCH

**Djoid says:** *"AI model classifies genre from audio characteristics — not metadata. 87% accuracy. 30+ subgenres."*

### Approach options
1. **Rule-based inference** (no model): combine BPM + energy + danceability + mood + key mode into genre heuristics — fast, no model needed, ~60–70% accuracy for common genres
2. **ONNX genre classifier**: a small CNN trained on mel-spectrograms. Could run in the existing Beat This! child-process worker. Requires a trained model (open-source options: Essentia-TensorFlow, Discogs-trained models).

Rule-based is the right first step; ONNX model is the stretch goal within this phase.

---

## Djoid Concepts Crate Already Does Better

| Djoid capability | Crate advantage |
|-----------------|----------------|
| Cue points (basic) | Beat This! ONNX auto-cue (Mix In / Drop / Break / Outro) + beatgrid editor |
| Export | Rekordbox, Serato, Traktor, Engine DJ, VirtualDJ — Djoid exports nothing |
| Library health | Duplicate scan, missing files, auto-locate, Smart Fixes |
| Custom metadata | Arbitrary key-value custom tags; Djoid has fixed fields only |
| Smart playlists | 14-field rule builder; Djoid has no smart playlists |
| Write tags to file | ID3/FLAC tag writer; Djoid does not touch files |
| Beatgrid editing | Inline GRID editor in player with tap, set-beat-here, neural AUTO |

---

## Technical Building Blocks (shared across phases)

### Track Feature Vector
`[bpm_norm, energy_norm, camelot_pos, danceability, mood]` — 5 floats
Used by: compatibility score, auto-group, magic sort, scatter map positioning, graph edge weights.

### Compatibility Score (current)
```typescript
camelotScore × 0.45 + energyScore × 0.30 + bpmScore × 0.25
```

### Compatibility Score (after Phase 1 — with mood)
```typescript
camelotScore × 0.35 + energyScore × 0.25 + bpmScore × 0.20 + moodScore × 0.20
```
`moodScore = 1 − Math.min(1, Math.abs(a.mood − b.mood) / 1.5)`

---

## Sprint Order

```
Sprint 1:  Phase 1 — Emotion/Mood dimension ← BUILDING NOW
Sprint 2:  Phase 2 — Scatter Map / Library Compass
Sprint 3:  Phase 3 — Graph view in Set Builder
Sprint 4:  Phase 4 — Next Mode + Phase 5 — Advanced search
Sprint 5:  Phase 6 — Genre detection (rule-based first, ONNX stretch)
```
