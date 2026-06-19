# Set History Tab — Build Plan

**Status:** Plan / architecture (no code in this branch is current — verify symbols before building)
**Scope:** A dedicated **Set History** tab: import played sets off a USB, browse them on a calendar, inspect each set, compare your latest set against previous ones, group sets into residencies, and prune practice/USB-check sessions you don't want to keep.

> **Foundation verified 2026-06-19** (against `src/main`): `playlists.is_history` (`library/schema.ts`, `ipc/library.ts`), `readUsbHistory` (`integrations/pioneer-usb/history-reader.ts`), the `play_history` table (`library/schema.ts`), and Pioneer-USB mount detection all exist as the plan assumes. **One claim to re-confirm before building §0/§2:** the plan states ProLink live capture *persists a captured set as an `is_history` playlist* — `src/main/ipc/prolink.ts` is currently untracked and contains no `is_history` write, so either that path isn't built yet or it persists differently. Confirm before relying on a ProLink set source.

> **Relationship to the existing `SET_HISTORY_PLAN.md`:** that doc covers *"The Road Not Taken"* — the post-gig recommendation engine (what else in your bag would have fit). **This** doc is the complementary piece: the **history library, calendar, comparison and lifecycle UI**. They share the same imported data; this tab is where a set lives, and "Road Not Taken" is one analysis you can open *from* a set.

---

## 0 · What already exists (build on, don't rebuild)

Confirmed in the current code (`src/main`):

- **A set is a history playlist.** `playlists.is_history = 1` rows hold the ordered tracks of a played set. Created today by:
  - `readUsbHistory(usbRoot, db)` (`integrations/pioneer-usb/history-reader`) — reads Pioneer `HISTORY` off a returned stick, via `library:readUsbHistory` IPC.
  - ProLink live capture (`ipc/prolink.ts`) — persists a captured live set as an `is_history` playlist.
- **`play_history`** table — per-play events: `track_id, played_at, mixed_from, mixed_into, deck_id`. Already powers a plays-per-day calendar and per-track cut history.
- A 52-week **plays-per-day calendar** pattern already exists (reuse it at set granularity).

**The gap this tab fills:** history playlists have no *set-level* metadata (when/where it was played, residency, rating, keep-vs-discard) and there's no calendar/compare/lifecycle UI over them. That's what we add.

---

## 1 · The Set entity

Introduce set-level metadata alongside the existing history playlist, rather than overloading `playlists`.

```sql
CREATE TABLE set_sessions (
  id            TEXT PRIMARY KEY,
  playlist_id   TEXT REFERENCES playlists(id) ON DELETE CASCADE,  -- ordered tracks live here
  title         TEXT,                  -- "Sat 14 Jun · The Cause"
  played_on     TEXT,                  -- gig datetime (from HISTORY timestamps)
  source        TEXT,                  -- 'usb-history' | 'prolink-live' | 'manual'
  device        TEXT,                  -- CDJ/mixer model or USB volume label
  history_ref   TEXT,                  -- e.g. 'HISTORY 014@<device>' — dedupe key on re-import
  residency_id  TEXT REFERENCES residencies(id) ON DELETE SET NULL,
  venue         TEXT,
  rating        INTEGER,               -- your own 1–5 on how it went
  vibe          TEXT,                  -- free tag: 'warm-up', 'peak', 'closing', 'after-hours'
  notes         TEXT,                  -- debrief notes
  recording_path TEXT,                 -- optional link to a recorded mix (you already record)
  status        TEXT NOT NULL DEFAULT 'kept',  -- 'kept' | 'archived' | 'unsorted'
  imported_at   TEXT,
  -- denormalised summary, computed once on import for a fast calendar/list:
  track_count   INTEGER, duration_sec REAL,
  avg_bpm REAL, bpm_min REAL, bpm_max REAL,
  energy_avg REAL, harmonic_pct REAL, new_track_pct REAL
);

CREATE TABLE residencies (
  id TEXT PRIMARY KEY, name TEXT, venue TEXT, color TEXT,
  cadence TEXT, notes TEXT, created_at TEXT
);
```

**Per-set timeline & transitions.** To support arcs and transition analysis, give each play event a home in a set. Cleanest: **extend `play_history`** so it doubles as the per-set timeline —

```sql
ALTER TABLE play_history ADD COLUMN session_id TEXT;   -- -> set_sessions.id
ALTER TABLE play_history ADD COLUMN sort_order INTEGER; -- play order within the set
ALTER TABLE play_history ADD COLUMN played_for_sec REAL; -- how long the track was up
```
Now one source feeds both the global cut-history and a set's ordered, timed timeline (BPM/energy/key arc + transitions). `Transition` shape can reuse the `PlayedSet`/`Transition` interfaces already sketched in `SET_HISTORY_PLAN.md` §2.

---

## 2 · Importing history off a USB (the post-gig pull)

The headline flow: plug the stick in after a gig, pull the new sets.

1. **Detect** the Pioneer USB (reuse `findPioneerUsbMount` / the Rekordbox-USB volume detection).
2. **List** the `HISTORY NNN` playlists on the stick with a preview (date, track count, duration) — *before* importing, so you choose what to keep.
3. **Dedupe** against `set_sessions.history_ref` (`HISTORY NNN@device`), so re-inserting the same stick doesn't double-import. Show each as **New** / **Already imported**.
4. **Import** selected histories → create a `set_sessions` row + the history playlist + timed `play_history` rows; resolve each played track to the library (or mark unknown); compute the summary metrics once.
5. **Auto-triage** likely throwaways (see §7): anything that looks like a USB-check or a practice doodle lands as `status = 'unsorted'` for review, not silently kept.

**Quality-of-life:** optional "watch for a Pioneer stick and offer to import on insert" (mirrors the existing watch-folder pattern), and reconcile a USB-history set with a ProLink-captured set from the same night (same date + heavy track overlap → offer to merge, keeping the richer one).

---

## 3 · Calendar view

The home of the tab. Reuse the existing 52-week heatmap pattern, but at **set** granularity.

- **Month / year calendar** with a marker on every day you played; a day can hold multiple sets. Colour the marker by **residency** (using `residencies.color`).
- **Heatmap mode** (GitHub-contributions style) for gig density across a year — instantly shows busy stretches, dry spells, streaks.
- Click a day → the set(s) that day; click a set → §4 detail.
- **Filters:** residency, venue, date range, status (hide `archived`), "has recording", free-text track search ("show every night I played this record").
- **List view** toggle (sortable table: date, venue, residency, length, tracks, avg BPM, rating) for power browsing.

---

## 4 · Set detail

What we show for one set:

- **Header:** title, date, venue, residency chip, device, duration, rating, source badge (USB / ProLink / manual).
- **The timeline / running order:** the played tracks in order with start time and how long each was up — reuse the editorial running-order renderer. Mark unknown (not-in-library) tracks.
- **Arc charts:** BPM curve, energy curve, and the **key journey** around the Camelot wheel over the set's duration (you already compute energy/mood/key).
- **At-a-glance stats:** track count, avg/min/max BPM, harmonic-mix %, % new vs repeated tracks, longest blend, genre/mood split, busiest 20-min window ("peak").
- **Transitions:** the A→B handovers with BPM/key/energy deltas (flag the rough ones).
- **Actions:** tag residency/venue/vibe, rate, add notes, attach a recording, **open "The Road Not Taken"** for this set, export (see §8), archive/delete (§7).

---

## 5 · Comparison engine (latest vs previous)

A dedicated **Compare** section. Two modes:

**A) Latest vs baseline.** Compare your most recent set against either the *previous* set, a *chosen* set, or the *rolling average* of the last N (optionally scoped to a residency, §6). Present as a side-by-side scorecard with deltas:

| Metric | Why it matters |
|---|---|
| Duration / track count / tracks-per-hour | pacing — are you rushing or stretching? |
| Avg & range of BPM, BPM-arc shape | tempo journey vs a flat set |
| Energy-arc shape | did you build and release, or sit still? |
| Harmonic-mix % (Camelot-adjacent transitions) | mixing tightness |
| Key diversity | range vs one-key rut |
| Genre / mood split | breadth of the night |
| **% new tracks** (not played in last K sets) | are you evolving or coasting? |
| **% repeats from last set / residency** | over-rotation (esp. for regulars, §6) |
| Rough-transition count | execution |
| Library coverage % | how much of your bag you actually use |

**B) Overlay / "versus".** Plot two (or more) sets' BPM + energy arcs on the same axes, and a **shared-tracks** diff: what both sets contained, what was unique to each. Great for "this week vs last week."

**Signature distance (stretch).** Using the per-track feature vectors/embeddings from the analysis pipeline, compute a single "how different was this set from my usual" score — surfaces drift from your norm at a glance.

---

## 6 · Residencies (tag & scoped compare)

- Create a **residency** (name, venue, colour, cadence). Tag any set with one (and bulk-tag, e.g. "every Cause set").
- **Residency dashboard:** every set under it on its own calendar; the residency's **rolling averages** (the baseline §5 compares against); trends over time (is the room's energy creeping up? are sets getting longer?).
- **Rotation tracker — the killer residency feature:** for a *regular* crowd, repeats are a liability. Show **most-played tracks at this residency** and **"played N weeks running"** so you can consciously rest a record. Inverse: **"rested" gems** you haven't aired there in a while.
- Compare **within** a residency by default (a peak-time club night shouldn't be benchmarked against a Sunday brunch warm-up).

---

## 7 · Session lifecycle (prune practice & USB-checks)

Not every HISTORY is a gig. Handle the noise without ever silently destroying real sets.

- **Soft states:** `unsorted` (needs triage) → `kept` or `archived`. **Archive hides; delete removes.** Delete asks for confirmation and warns if the set has notes/rating/recording.
- **Auto-triage heuristics** (tunable, *suggest* don't auto-delete): flag as likely-throwaway when a session has **< N tracks** (e.g. 3), **total duration < X min** (e.g. 10), or **every track was up only a few seconds** (a USB sound-check). These land as `unsorted` with a "looks like a soundcheck/practice — discard?" prompt.
- **Bulk actions:** select many → archive/delete; "delete all unsorted under 3 tracks."
- **"Practice" as a first-class status** (optional): keep practice sessions but exclude them from residency stats and comparisons by default, so they don't pollute your real numbers.
- **Undo / trash:** deletes go to a recoverable trash for a grace period rather than an immediate hard delete.

---

## 8 · Ideas to make this page *amazing*

Ranked roughly by impact-to-effort:

1. **Auto-generated set debrief.** One paragraph per set: "108→126 BPM build over 95 min, energy peaked at 01:10, 78% harmonic mixing, 6 tracks you'd not played in 3 months, two rough key jumps at 00:40 and 01:25." Turns raw data into a coach's note.
2. **"Secret weapons" & "crutches" per residency.** Tracks that consistently appear (crutches — consider resting) vs high-impact tracks you rarely deploy (secret weapons). Built purely from your own history.
3. **Track rotation heatmap.** A grid of your top tracks × recent sets — see at a glance what you lean on and where you're repeating to the same crowd.
4. **Streaks, milestones & a year-in-review.** Gigs this month, longest streak, total hours played, "Wrapped"-style annual recap (most-played, biggest night, new tracks introduced).
5. **Open "The Road Not Taken" from any set** — the existing recommendation engine as the natural deep-dive (one shared data model).
6. **Export & share a set** — as a tracklist (1001TL-style text), a playlist back into the library, a running-order PDF (you already export PDFs), or a CSV. "Recreate this set as a playlist" to re-prep a winning night.
7. **Attach the recording** and scrub the timeline against the waveform of the actual mix (you already record sets and render waveforms).
8. **B2B detection.** Use `deck_id` patterns to detect back-to-back sets and (optionally) attribute tracks per DJ.
9. **Goals & nudges.** Set a goal ("introduce ≥3 new tracks per set", "keep repeats under 20% at the residency") and track it across sets.
10. **Venue/room memory.** Notes that persist per venue ("the system here is bass-heavy, pull the lows") surfaced whenever you tag a set there.
11. **Crowd-response capture (manual, honest).** Quick per-track 👍/👎/🔥 during or after a set → a "crowd-tested" confidence signal that feeds future prep and Road-Not-Taken scoring. Kept clearly as *your* subjective marks, not invented data.
12. **Set search across everything** — "find every night I opened with X" / "all sets between 124–128 BPM at The Cause."

---

## 9 · Data-model summary

- **New:** `set_sessions`, `residencies` (§1).
- **Extend:** `play_history` with `session_id, sort_order, played_for_sec` (per-set timeline).
- **Reuse:** `is_history` playlists (ordered tracks), the existing USB-history + ProLink importers, the calendar/heatmap pattern, the running-order renderer, energy/mood/key/beatgrid analysis, PDF export, recording.
- Summary metrics are **denormalised onto `set_sessions` at import** so the calendar/list/compare stay instant; the timeline/arc detail is computed on demand from `play_history`.

---

## 10 · Surface (IPC sketch)

```
setHistory:listUsbHistories(usbRoot)      -> [{ ref, playedOn, trackCount, durationSec, alreadyImported }]
setHistory:import(usbRoot, refs[])        -> imported set ids
setHistory:list(filter)                   -> set summaries (for calendar/list)
setHistory:get(id)                        -> full set: timeline + transitions + arcs + metrics
setHistory:update(id, patch)              -> residency/venue/rating/vibe/notes/status
setHistory:compare(aId, bIds | baseline)  -> comparison scorecard + overlay series
setHistory:delete(id) / archive(id)       -> soft trash / archive
residencies:crud(...)                     -> residency management + dashboard rollups
```

---

## 11 · Phasing

1. **Import + store + calendar** — `set_sessions`, USB-history import with dedupe + preview, calendar/list browsing, basic set detail (timeline + summary stats). *Milestone: plug in the stick, see every night on a calendar.*
2. **Lifecycle** — soft archive/delete, auto-triage of practice/USB-checks, trash/undo. *Milestone: your history is clean, only real sets remain.*
3. **Residencies** — tagging, residency dashboard + rolling baselines, rotation tracker. *Milestone: compare like-for-like, spot over-rotation.*
4. **Comparison engine** — latest-vs-baseline scorecard, overlay/versus, shared-tracks diff. *Milestone: "this week vs last."*
5. **Amazing layer** — auto debrief, secret-weapons/crutches, exports, recording scrub, year-in-review, and the link into "The Road Not Taken."

Phases 1–2 are self-contained and immediately useful; 3–4 are the differentiators; 5 is the delight.

---

## 12 · Open decisions

- **Set identity on re-import:** is `HISTORY NNN@device` + date a robust enough dedupe key across multiple sticks/players? (Likely yes; confirm against real HISTORY metadata.)
- **Timeline source of truth:** extend `play_history` (recommended, one source) vs a separate `set_track_plays` table (cleaner separation, more plumbing).
- **Auto-triage thresholds:** the track-count/duration cut-offs for "looks like a soundcheck" — make them user-tunable.
- **Practice sessions:** separate `status` vs a per-set "exclude from stats" flag.
- **Privacy:** all set history stays local (consistent with the rest of the app); any share/export is an explicit user action.
