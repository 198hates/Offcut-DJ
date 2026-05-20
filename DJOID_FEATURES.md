# Djoid — Feature Audit & Implementation Notes

**What it is:** Desktop DJ preparation / curation platform (macOS + Windows). Not a mixer or performance tool.  
**Pricing:** €15/month Basic, €35/month Pro, or €99/year.  
**Competitors:** Lexicon DJ, Mixed In Key, DJ.Studio.  
**Relevant to Offcut as:** A benchmark for curation intelligence features — the kind of "preparation layer" Offcut could grow into.

---

## 01 · Chapter Builder

**What it does:**  
Structures a DJ set into 3–20 "energy blocks" called chapters. Each chapter groups tracks that share compatible energy, mood, and harmonic character. Tracks are ordered within a chapter using Djoid's compatibility engine. Chapters export directly to Rekordbox/Serato as crates.

**Creation workflows:**
- Start from a seed track, let the engine suggest compatible tracks to fill the chapter
- Run AutoGroup on a subset, then treat suggested groups as chapter candidates
- Filter library by attributes (BPM range, energy, key) and manually curate

**How to implement in Offcut:**
- Data model: a `chapters` table linked to a playlist, with an `order` column and an `energy_profile` JSON blob (`{ bpmMin, bpmMax, energyMin, energyMax, keyCluster }`)
- UI: a new "Set Builder" page (nav section after Analysis). Chapters shown as swimlane columns or a timeline strip. Tracks drag between chapters.
- Compatibility scoring: use existing BPM + key data. Camelot Wheel distance gives harmonic score (0–1). Energy diff gives energy score. Combine as weighted sum.
- Export: each chapter → playlist in whichever target format. Already have Rekordbox/Serato export.

**Status in Offcut:** Partial — playlists exist but no chapter/arc structure or compatibility ordering.

---

## 02 · Graph Playlists

**What it does:**  
Displays tracks as nodes in a force-directed graph. Edges connect tracks with high compatibility. Hovering a node previews the track. Clicking expands to show its closest matches. Used to discover transition paths through a collection.

**How to implement in Offcut:**
- Graph data: for each track compute pairwise compatibility score against all other tracks. Store top-N (e.g. 10) edges per track in a `track_edges` table (`track_a`, `track_b`, `score REAL`).
- Rendering: `d3-force` or `@react-spring/web` with a canvas-drawn graph. Nodes = circle sized by BPM or energy. Edges = lines weighted by score opacity.
- Hover preview: play a 5-second excerpt via Web Audio API (same `readFile` → `decodeAudioData` pipeline we already have).
- Build edges: O(N²) — for 10,000 tracks that's 100M comparisons, too slow on load. Instead compute lazily: when a track is focused, compute its top-N neighbours on demand in a worker.
- Compatibility score formula:  
  ```
  score = 0.4 * harmonicScore(keyA, keyB)   // Camelot distance 0–1
        + 0.3 * energyScore(energyA, energyB) // 1 - |a-b|/10
        + 0.2 * bpmScore(bpmA, bpmB)           // 1 - |a-b|/30 clamped to 0
        + 0.1 * genreScore(genreA, genreB)     // 1 if same, 0.5 if related, 0 otherwise
  ```

**Status in Offcut:** Not started. High effort — primarily the force-graph UI.

---

## 03 · Scatter Map

**What it does:**  
Plots every track in the library as a point in a 2D space. Tracks with similar musical characteristics cluster together ("vibe islands"). You can lasso-select a region and extract it as a playlist.

**How to implement in Offcut:**
- Dimensionality reduction: each track has a feature vector `[normBpm, normEnergy, harmonicGroup, normDanceability, normEmotion]`. Run UMAP or t-SNE to project to 2D. UMAP.js is a small JS library that runs in a worker.
- Rendering: canvas scatter plot with zoom/pan. Each point sized ~4px, coloured by genre category colour from the existing `cat` palette.
- Lasso select: track pointer drag to draw a polygon, then point-in-polygon check to extract track IDs.
- On click: show a tooltip with title/artist. Double-click to load to deck.
- Recalculate: run after each bulk import (deduplicate by hashing the input feature vectors).

**Status in Offcut:** Not started. UMAP projection is the main new piece; the canvas infrastructure already exists in the waveform components.

---

## 04 · Auto Group (Auto Crates)

**What it does:**  
Analyses the full library and suggests groupings of compatible tracks without user input. Groups are non-destructive views (not permanent storage). Re-runs as the library grows.

**How to implement in Offcut:**
- Algorithm: k-means or DBSCAN clustering on the same feature vectors used for Scatter Map. DBSCAN is better here — no need to specify k, handles irregular cluster shapes, naturally produces "noise" tracks that don't fit any cluster.
- Run in a Node.js worker (main process side) so it can access the full SQLite library without crossing IPC.
- Results stored in a `generated_playlists` table with `type = 'autogroup'`. Shown in the sidebar under a "Generated" section.
- Refresh trigger: manual button in the Analysis section or auto after import if track count changed by > 10%.
- UI: show clusters ranked by size. Each cluster gets an auto-generated name from the most common genre + avg BPM, e.g. "Tech House · 130–135".

**Status in Offcut:** Not started.

---

## 05 · Magic Sort

**What it does:**  
Automatically reorders tracks within a playlist to create the most compatible playable sequence. Considers both harmonic key and energy flow simultaneously. Flags tracks that can't be placed without an incompatible jump.

**How to implement in Offcut:**
- This is a Hamiltonian path problem (NP-hard in general). Use a greedy nearest-neighbour heuristic: start from the highest-energy track, at each step pick the unvisited neighbour with the highest compatibility score.
- Optionally run 2-opt improvement passes to un-cross obvious swap opportunities.
- Works on the `compatibility score` defined above in §02.
- Flagged tracks: those where the best available next-track score falls below a threshold (e.g. 0.35). Surface these in a separate "hard transitions" list the user can review.
- Entry point: right-click a playlist → "Magic Sort" or a button in the playlist header.
- Runs in a worker. For 100 tracks, nearest-neighbour + one 2-opt pass is < 100ms.

**Status in Offcut:** Not started. Existing compatibility score building block needs to be added first.

---

## 06 · Matching Tracks (Recommendations)

**What it does:**  
Two modes:  
- **Matching mode:** Given a playlist, finds tracks from the full library that fit the playlist's overall vibe (thematic + energetic).  
- **Next mode:** Finds the single best track to play after the last track in the playlist, weighting recent tracks more heavily.

**How to implement in Offcut:**
- Represent a playlist as a centroid: average of its tracks' feature vectors (BPM, energy, harmonic position, etc.).
- For Matching mode: rank all non-playlist tracks by cosine similarity to the centroid. Return top 20.
- For Next mode: weight the centroid computation heavily toward the last 3 tracks (e.g. weights `[1, 0.8, 0.6, 0.3, 0.3, …]` from the end). Return top 5 with a one-sentence "why" (e.g. "same key, +2 BPM, similar energy").
- UI: a "Suggestions" panel that slides in from the right of the Library page when a playlist is active, or a context menu option "Find matching tracks".
- Already have the library store and filtering infrastructure to show results in the existing track table.

**Status in Offcut:** Not started.

---

## 07 · Genre Detection

**What it does:**  
AI model classifies each track into a genre and subgenre. 87% accuracy claimed. Covers 30+ subgenres as of v1.2.4. Standardises naming so the library uses consistent conventions rather than whatever tags came with the files.

**How to implement in Offcut:**
- Best approach: use a pre-trained audio classification model. Options:
  - **Essentia-TensorFlow** — open-source, includes genre models trained on Discogs taxonomy. Can run via `onnxruntime-node` after export.
  - **Musicbrainz AcousticBrainz** — deprecated but its trained models are public.
  - **Fallback:** tag normalisation without audio analysis — map free-text genre strings to a canonical taxonomy using a lookup table + fuzzy matching (fast, no model needed, lower accuracy).
- Pipeline: decode audio → extract mel spectrogram (already implemented for beat analysis) → run genre model → write to `tracks.genre` + new `tracks.subgenre` column.
- Run in batch via the Analysis section, or on import when genre tag is missing.

**Status in Offcut:** Not started. Beat analysis ONNX pipeline (already built) provides the foundation.

---

## 08 · AI Tagging — BPM, Key, Energy, Danceability, Emotion

**What it does:**  
Analyses each track and assigns six attributes: BPM, key, energy (kick strength + overall intensity), danceability (rhythmicality + syncopation), emotion/mood, genre. Displayed on track cards. Never modifies audio files.

| Attribute    | Already in Offcut? |
|--------------|--------------------|
| BPM          | Yes — BPM worker   |
| Key          | Yes — key worker   |
| Energy       | Partial — `energy` column, set 1–10, not auto-detected |
| Danceability | No                 |
| Emotion/Mood | No                 |
| Genre        | Partial — tag import only, no detection |

**How to implement missing attributes:**

**Energy (auto):** Compute RMS energy of the track. Optionally separate kick energy using the existing low-frequency band peaks. Normalise to 1–10 scale against the library distribution. Fast — O(N) over samples.

**Danceability:** Measure onset regularity and syncopation from the beat grid (if available). Ratio of beats that align to a strict 4/4 grid vs. off-grid hits. Can also derive from low-frequency spectral flux. Range 0–1.

**Emotion/Mood:** Requires a classification model. Valence (happy/sad) and arousal (energetic/calm) are the two standard axes (Russell circumplex model). Pre-trained models available via Essentia. Store as `mood_valence REAL, mood_arousal REAL` and map to human labels for display.

**Status in Offcut:** BPM + key done. Energy field exists but manual. Danceability and mood not started.

---

## 09 · Cue Points

**What it does:**  
Mark specific moments in tracks (verse starts, drops, mix-in/out points). Colour-coded, named. Sync to Rekordbox via its XML format.

**Status in Offcut:** Fully implemented. Cue points stored in `cue_points` table. Colour-coded. Exported in Rekordbox XML. Shown on waveform.

**Gaps vs Djoid:**  
- Djoid has auto-generated cue points (e.g. detect first beat, chorus, drop via energy change detection). Offcut requires manual cue placement.
- Auto-cue implementation: find the highest energy onset after the track's intro section (first 16–32 bars). Set the main cue there. Optionally set cue points at every significant energy change above a threshold.

---

## 10 · Import

**Supported sources:** Rekordbox, Traktor, Serato, Apple Music.

**Status in Offcut:** Fully implemented for all four, plus Engine DJ and M3U.

---

## 11 · Export

**Supported destinations:** Rekordbox, Serato, VirtualDJ, Traktor.

**Status in Offcut:** Rekordbox XML, Traktor NML, Serato, Engine DJ. No VirtualDJ yet.

**VirtualDJ implementation:**  
VirtualDJ stores its database in `VirtualDJ/database.xml`. Format is similar to Rekordbox XML — tracks have `<Song>` elements with `FilePath`, `Tags`, `Poi` (cue points). Implement as a new writer in `src/main/integrations/virtualdj/`.

---

## 12 · Library Organisation & Search

**Djoid capabilities:** Filter by genre, subgenre, BPM, energy, danceability, mood, release date, custom tags. Up to 10,000 tracks (limit being removed).

**Status in Offcut:** Filtering by BPM, key, genre, artist, rating, title. Smart playlists with rules. No limit.

**Gaps:**
- No danceability / mood filter (needs those attributes first — see §08)
- No subgenre column
- Release date not stored (add `releaseYear INTEGER` column via migration)
- Custom freeform tags exist (`tags TEXT[]` in schema) but no UI to filter by them in FilterBar

---

## Priority Implementation Order

Based on effort vs. value for an Offcut user:

| Priority | Feature | Effort | Value |
|----------|---------|--------|-------|
| 1 | Auto Energy scoring on analysis | Low | High — fills gap in existing field |
| 2 | Matching Tracks (recommendations) | Medium | High — surfaces compatible tracks in-session |
| 3 | Magic Sort | Medium | High — one-click playlist sequencing |
| 4 | Auto-cue points | Medium | High — removes manual cue work |
| 5 | Danceability scoring | Medium | Medium |
| 6 | Genre Detection (ONNX) | High | Medium |
| 7 | Auto Group (clustering) | High | Medium |
| 8 | Chapter Builder UI | High | High — major workflow feature |
| 9 | Scatter Map | High | Medium |
| 10 | Graph Playlists | Very High | Medium |
| 11 | Mood/Valence detection | High | Low (niche) |
| 12 | VirtualDJ export | Low | Low (small user base) |

---

## Technical Building Blocks Summary

Most intelligence features share three building blocks. Build these first and the rest follows:

**1. Track Feature Vector**  
`[normBpm, normEnergy, camelotPosition, normDanceability, moodValence, moodArousal]`  
Stored as `tracks.feature_vector BLOB` (Float32Array, 6 floats, 24 bytes per track).  
Recomputed after each analysis pass.

**2. Compatibility Score**  
```typescript
function compatibility(a: Track, b: Track): number {
  const harmonic = camelotDistance(a.key, b.key)        // 0–1
  const energy   = 1 - Math.min(1, Math.abs((a.energy ?? 5) - (b.energy ?? 5)) / 5)
  const bpm      = 1 - Math.min(1, Math.abs((a.bpm ?? 120) - (b.bpm ?? 120)) / 30)
  return 0.45 * harmonic + 0.35 * energy + 0.20 * bpm
}
```
Already have `camelotDistance` implied by the `keyBlipColor` / `CamelotWheel` component.

**3. Batch Analysis Worker**  
Extend the existing BPM/key worker to also emit energy, danceability, and (optionally) mood values in the same pass. Avoids re-decoding audio multiple times.

---

*Last updated: 2026-05-20*
