# Lexicon Feature Implementation Plan

Reference: audit of Lexicon DJ's advertised feature set mapped against Crate's current state.
Last updated: 2026-05-19

---

## Already Implemented ✓

| Feature | Status | Notes |
|---------|--------|-------|
| Import from Rekordbox | ✓ Done | SQLCipher reader |
| Import from Serato | ✓ Done | GEOB tag reader |
| Import from Traktor | ✓ Done | NML reader |
| Import from Engine DJ | ✓ Done | SQLite reader |
| Export to all above | ✓ Done | Writers for all 4 |
| BPM analysis | ✓ Done | Web Worker, essentia.js |
| Key analysis | ✓ Done | Web Worker, Camelot output |
| Energy field | ✓ Done | Schema + UI |
| Smart Fixes (basic) | ✓ Done | 8 algorithms, preview+apply |
| Smart Playlists | ✓ Done | Rule builder, 14 fields |
| Play count + last played | ✓ Done | IPC handler, player integration |
| FN-BUS filters | ✓ Done | 8 one-touch filters |
| Cue points (display) | ✓ Done | Read from all integrations |

---

## Tier 1 — Next Sprint (high value, contained scope)

### 1. Duplicate Detection
Finds duplicates by title+artist match, file hash, or acoustic fingerprint. Shows side-by-side comparison, lets you pick which copy to keep.

**Implementation**:
- Phase 1 (easy): In-memory scan — group `tracks` by `title.toLowerCase() + artist.toLowerCase()`, surface groups with `count > 1` in LibraryHealth
- Phase 2 (medium): File hash — read first 64KB of each file, hash with `crypto.createHash('md5')`, group by hash. Catches exact file copies regardless of tags
- Phase 3 (hard): Acoustic fingerprint via Chromaprint/AcoustID — requires native binary, out of scope for now

**UI**: New LibraryHealth section "Duplicates", accordion groups, "keep this / remove that" per pair. Uses existing `deleteTracks` bulk action.

**Effort**: ~1 day for Phase 1+2

---

### 2. Write Tags to File
Writes all metadata (title, artist, BPM, key, rating, genre, cue points, beatgrid) back to the actual audio file's ID3/FLAC/MP4 tags.

**Implementation**:
- Use `node-music-metadata` (already likely installed for reading) + `node-id3` for MP3 writes, `flac-metadata` for FLAC
- IPC handler: `library:writeTagsToFile(trackId)` — reads track from DB, opens file, writes standard fields + TXXX tags for Crate-specific data
- UI: Button in TrackDetail "Write to file", bulk action in Library, toggle in Settings "Auto-write on edit"

**Effort**: ~1.5 days

---

### 3. Playlist Export (M3U8 + CSV)
Exports any playlist to M3U8, CSV, HTML, or PDF. M3U8 is the DJ-standard format; CSV enables spreadsheet workflows.

**Implementation**:
- `library:exportPlaylistM3U8(playlistId, filePath)` — `#EXTM3U` header + `#EXTINF:duration,Artist - Title\n/path/to/file`
- `library:exportPlaylistCSV(playlistId, filePath)` — CSV with all track fields
- PDF via `electron`'s `webContents.print()` or `pdfkit` — lower priority
- UI: Right-click context menu on playlist → "Export as…" submenu

**Effort**: ~0.5 days for M3U8+CSV

---

### 4. Watch Folder (Auto-Import)
Monitors a folder, auto-imports new audio files as they're added.

**Implementation**:
- `chokidar` (already in Electron ecosystem, likely already installed)
- Main process: `chokidar.watch(paths, { persistent: true })` on `.mp3|.flac|.aiff|.wav|.m4a`
- On `add` event: call existing M3U/file import path, refresh library
- Store watch paths in settings (already have settings IPC)
- UI: Settings → "Watch Folders" section, add/remove paths

**Effort**: ~1 day

---

### 5. Track Colour Tags
Assigns a colour to individual tracks (not just playlists), visible in the library grid.

**Implementation**:
- Schema: `ALTER TABLE tracks ADD COLUMN color TEXT` (migration already follows the pattern)
- Update `rowToTrack`, `updateTrack` IPC
- UI: Color picker in TrackDetail (same 10-colour palette as playlist blips), coloured left-border on library rows

**Effort**: ~0.5 days

---

### 6. Genre / Artist Cleanup (Bulk Normalization)
Scans library for inconsistent genre/artist spellings (e.g. "techno" vs "Techno" vs "TECHNO"), shows grouped counts, lets you pick canonical form and apply to all.

**Implementation**:
- New Smart Fixes algorithms: group `tracks` by `genre.toLowerCase()`, surface case variants. Same preview/apply pattern as existing SmartFixes page.
- "Artist cleanup" is similar: group `artist.toLowerCase()`, find casing variants
- Could also add: merge genre A → genre B (e.g. "Tech House" → "Tech-House"), regex-based normalization

**Effort**: ~1 day, fits entirely in existing SmartFixes page

---

## Tier 2 — Medium Complexity

### 7. Lost Track Recovery + Broken Scan
Finds tracks where the file no longer exists at `filePath`, and attempts to find them by filename match in user-selected search paths.

**Implementation**:
- IPC handler: `library:scanBrokenTracks()` — `fs.existsSync(track.filePath)` for each track, returns broken list
- Recovery: For each broken track, search user-provided paths for matching filename, score by similarity
- UI: LibraryHealth section "Broken Tracks", shows count + path, "Locate" button opens folder picker, "Auto-Locate" scans a search path

**Effort**: ~1.5 days

---

### 8. Custom Tags (User-Defined Fields)
Lets users create their own metadata fields (e.g. "Mood", "Crowd Energy", "Label") stored per-track.

**Implementation**:
- Schema option A: `custom_tags TEXT NOT NULL DEFAULT '{}'` — JSON blob per track (flexible for ad-hoc fields)
- Schema option B: separate `track_custom_tags(track_id, key, value)` table (better for querying/filtering in smart playlists)
- UI: TrackDetail "Custom Tags" section, inline add/edit, show in Library as optional column
- Smart Playlist: add `customTag.*` to rule field options

**Effort**: ~2 days (schema + IPC + UI + smart playlist integration)

---

### 9. History Timeline + Statistics
Shows a calendar/timeline of plays, statistics charts (most played, most played genre, plays per day, etc.)

**Implementation**:
- Data already there: `play_count` + `last_played_at` per track
- Phase 1: Simple stats in Settings or new "Insights" sidebar section — top 10 most played, genre breakdown, plays this week
- Phase 2: Calendar heatmap (GitHub-style) — group plays by date, render 52-week grid
- Phase 3: Full history requires storing per-play events — add `play_history(track_id, played_at)` table (schema change)

**Effort**: Phase 1 ~0.5 days, Phase 2 ~1 day, Phase 3 ~2 days

---

### 10. Playlist Tools (Merge, Shuffle, Sort, Cross-Reference)
Merge two playlists into one, shuffle order, sort by field, show tracks in playlist A not in B.

**Implementation**:
- All operate on `playlist.trackIds` arrays — pure array operations
- Merge: union of two `trackIds` arrays → new playlist
- Shuffle: Fisher-Yates on trackIds → `updatePlaylist`
- Sort: reorder trackIds by track field (e.g. sort by BPM) — confirm DB stores order
- Cross-reference (diff): `setA.difference(setB)` — highlight or export to new playlist

**Effort**: ~1 day

---

### 11. Beatgrid Editing
Shows a waveform with beatgrid overlay, lets user drag beat markers to correct misaligned grids.

**Implementation**:
- Requires: decoded waveform data (Web Audio `decodeAudioData`), peak array → canvas render
- Beatgrid model: `{ bpm, offset, anchors[] }` — already partially in cue point schema
- UI: Full-width waveform panel in TrackDetail or dedicated editor modal
- Write back: update beatgrid anchors in DB, sync to Rekordbox/Serato on next export

**Effort**: ~4-5 days (most visually complex feature)

---

## Tier 3 — Significant Complexity

### 12. Find Mixable Tracks / Track Matcher
Given the currently loaded track, finds library tracks sorted by harmonic compatibility + BPM proximity + energy match.

**Implementation**:
- Pure JS — already have `camelotCompatible()` function and BPM range logic from FN-BUS
- Score = harmonic match (0/1) × 40 + BPM proximity score × 40 + energy proximity × 20
- UI: Panel in TrackDetail "Mixable Tracks" — sorted list, load-to-deck button

**Effort**: ~1 day (algorithm is straightforward; UI integration is the work)

---

### 13. Path Mappings (Relocate Root)
When a library is moved to a new drive/path, a single mapping rule fixes all broken paths at once.

**Implementation**:
- Store mappings in settings: `pathMappings: [{from, to}]`
- `library:applyPathMapping(from, to)` — `UPDATE tracks SET file_path = REPLACE(file_path, ?, ?)` — single SQL statement fixes entire library

**Effort**: ~0.5 days

---

### 14. Auto-Cue Generation with Templates
Analyses tracks and auto-places hot cues at musically significant points (intro end, drop, breakdown) using configurable templates.

**Implementation**:
- Requires waveform analysis (energy/RMS over time) to find transients — extends existing audio worker
- Template: "place cue at loudest onset in bars 1-8" etc.
- Depends on beatgrid being correct first

**Effort**: ~3 days

---

## Tier 4 — Out of Scope / Future

| Feature | Reason |
|---------|--------|
| Send to Spotify | OAuth + Spotify API, needs backend for token refresh |
| Beatport/iTunes/Billboard Charts | Rate-limited external APIs, changing endpoints |
| Cloud database/sync | Needs backend infrastructure |
| Mobile apps | Separate React Native codebase |
| Store links (pricing) | Aggregates multiple store APIs, maintenance-heavy |
| Danceability/happiness/popularity analysis | Requires ML models (AcousticBrainz is retired) |

---

## Recommended Build Order

```
Sprint 1:  Track colour tags → Duplicate detection (phase 1+2) → M3U8/CSV export → Path mappings
Sprint 2:  Genre/artist cleanup → Write tags to file → Watch folder
Sprint 3:  Lost track recovery → Playlist tools → History/stats (phase 1)
Sprint 4:  Find Mixable Tracks → Custom tags → Beatgrid editing
```
