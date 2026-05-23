# Lexicon Feature Implementation Plan

Reference: audit of Lexicon DJ's advertised feature set mapped against Crate's current state.
Last updated: 2026-05-23

---

## Already Implemented ✓

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Import from Rekordbox | ✓ Done | SQLCipher reader |
| Import from Serato | ✓ Done | GEOB tag reader |
| Import from Traktor | ✓ Done | NML reader |
| Import from Engine DJ | ✓ Done | SQLite reader |
| Export to all above | ✓ Done | Writers for all 4 |
| BPM analysis | ✓ Done | Web Worker, essentia.js |
| Key analysis | ✓ Done | Web Worker, Camelot output |
| Energy field | ✓ Done | Schema + UI |
| Smart Fixes (basic) | ✓ Done | 15 algorithms, preview+apply |
| Smart Playlists | ✓ Done | Rule builder, 14 fields |
| Play count + last played | ✓ Done | IPC handler, player integration |
| FN-BUS filters | ✓ Done | 8 one-touch filters |
| Cue points (display) | ✓ Done | Read from all integrations |
| **Track colour tags** | ✓ Done | `tracks.color`; ColourPicker in TrackDetail edit tab; inset left border in library grid |
| **Duplicate detection** | ✓ Done | LibraryHealth §04 — artist+title, BPM+duration matching; auto-select extras; bulk delete |
| **M3U8 + CSV export** | ✓ Done | `library:exportPlaylistM3U` + `library:exportPlaylistCSV`; right-click menu on any playlist |
| **Path mappings** | ✓ Done | `library:previewPathMapping` + `library:applyPathMapping`; UI in Settings |
| **Genre/artist cleanup** | ✓ Done | SmartFixes algorithms 9 (Normalize Genre Spelling) + 10 (Normalize Artist Spelling) |
| **Write tags to file** | ✓ Done | FFmpeg writer at `integrations/file-tags/writer.ts`; single + bulk IPC; track context menu |
| **Watch folder** | ✓ Done | chokidar integration; `library:setWatchFolders` / `getWatchFolders`; Settings UI |
| **Lost track recovery** | ✓ Done | LibraryHealth §05 — disk scan + auto-locate + remove |
| **Playlist tools** | ✓ Done | Shuffle, Sort by (7 fields), Merge with, Tracks not in — sidebar context menu |
| **History/stats Phase 1** | ✓ Done | Play History in LibraryHealth — top tracks + genre breakdown |
| **Find Mixable Tracks** | ✓ Done | Mixable tracks panel in TrackDetail Inspector tab |
| **Custom tags** | ✓ Done | `customTags: Record<string,string>` in schema + TrackDetail "custom fields" section |

---

## Remaining — Tier 2

### 1. Beatgrid Editor (visual)

Shows a waveform with beatgrid overlay, lets user drag beat markers to correct misaligned grids.

**Implementation**:

- Waveform render: Web Audio `decodeAudioData` → peak array → canvas (reuse existing audio worker)
- Beatgrid model: `analysedBeatgrid` column + `Beatgrid` type already in schema/types — editor reads/writes this
- UI: Full-width canvas panel in TrackDetail (new "Grid" tab alongside Inspector / Edit)
- Interactions: click to add anchor, drag to move, right-click to delete; rubber-band zoom
- Write back: `updateTrack({ id, analysedBeatgrid: ... })` → syncs to Rekordbox/Serato on next export

**Effort**: ~4–5 days (most complex visual feature)

---

## Tier 3 — Significant Complexity

### 2. Auto-Cue Generation with Templates

Analyses tracks and auto-places hot cues at musically significant points (intro end, drop, breakdown) using configurable templates.

**Implementation**:

- Requires waveform analysis (energy/RMS over time) to find transients — extends existing audio worker
- Template: "place cue at loudest onset in bars 1-8" etc.
- Depends on beatgrid being correct first

**Effort**: ~3 days

---

## Tier 4 — Out of Scope / Future

| Feature | Reason |
| ------- | ------ |
| Send to Spotify | OAuth + Spotify API, needs backend for token refresh |
| Beatport/iTunes/Billboard Charts | Rate-limited external APIs, changing endpoints |
| Cloud database/sync | Needs backend infrastructure |
| Mobile apps | Separate React Native codebase |
| Store links (pricing) | Aggregates multiple store APIs, maintenance-heavy |
| Danceability/happiness/popularity analysis | Requires ML models (AcousticBrainz is retired) |
