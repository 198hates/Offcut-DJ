# Offcut Mobile — competitive roadmap

Research synthesis (deep-research, 2026-06-18) tailored to Offcut Mobile's
architecture: a LAN/cloud **companion** to the desktop library manager that
**auditions a streamed AAC proxy** per track and runs **no on-device DSP**
(no EQ/filter/FX/sync/crossfader/stems — single-file playback via the OS player).

Feasibility tags reflect a **code-verified** audit of the desktop/mobile repo
(not just the task history). `[on-device]` = pure client logic on mirrored data,
no desktop round-trip. `[needs-desktop]` = compute on the Electron app, surface/
edit/trigger from mobile. `[infeasible]` = needs on-device DSP or streaming DRM.

## Closest competitor
**Lexicon DJ Mobile** — does cue/loop editing, full beatgrid editing, quantize,
categorized custom tags, and any-field edits entirely on the phone. Offcut is
already at rough parity (hot cues, beat-loops, quantize, 3-band grid waveform,
rating/energy/mood/tags/colour edits). Sources: lexicondj.com/mobile-app,
lexicondj.com/manual/tags, lexicondj.com/manual/cue-point-generator.

## Tier 1 — prep parity (all `[on-device]`; verified inputs already mirrored)
1. **Rule-based smart playlists** — match BPM/key/energy/mood/rating/tags client-side.
   Parity with rekordbox Intelligent Playlists, Serato Smart Crates, Lexicon Smartlists.
   *Verified: those fields are in the mobile wire `Track`.*
2. **Categorized, colour-coded tags + OR/AND filtering** — upgrade free-form tags to
   Lexicon's model (same category = OR, cross category = AND). Pairs with #1.
3. **Key + energy/BPM organisation** — Camelot grouping, sort/filter views.
   *Verified: keys canonicalised to Camelot on desktop (`key-notation.ts`).*

## Tier 2 — differentiators
4. **Surface auto-cue to mobile** `[needs-desktop, mostly done]` — auto-cue +
   phrase-aware cues already generate on the desktop (`analyzer.ts`,
   `cueTemplates.ts`, `phraseDetect.ts`) and write `cuePoints`, which **already
   sync to mobile**. Work = a "analyse this track" trigger from the phone + showing
   phrase bands on the waveform (send phrases like the compact grid). NOT new ML.
5. **Expanded hot cues (8→16, named/coloured) + named beat-loops** `[on-device]` —
   djay parity; pure UI/metadata.
6. **"Export to USB/CDJ" triggered from mobile** `[needs-desktop]` — desktop already
   writes `export.pdb` + rekordbox-XML/Serato/Engine; mobile just kicks it off.
7. **Robust cloud relay** `[needs-desktop]` — the planned Google Drive relay; parity
   with rekordbox Cloud Library Sync (Dropbox+Drive) / Engine Dropbox. Parity, not ahead.

## Tier 3 — nice-to-have
8. **"Tracks like this" — metadata** `[on-device]` — key/BPM/energy/tags similarity;
   `roadNotTaken.ts` already scores on metadata.
9. **"Tracks like this" — audio (sound-alike)** `[needs-desktop, NOT yet built]` —
   the consumer UI exists (`TrackDetail` SOUND mode) but **no embedding generator
   exists** (`roadNotTaken.ts`: "no audio embeddings yet"). Requires building an ONNX
   embedding pass in the main process first — a real project, not wiring.
10. **Collaboration / shared playlists** `[needs-desktop]` — via the relay.

## Explicitly INFEASIBLE on the phone (do not attempt)
Real-time **EQ / filter / FX / crossfader / sync / stems** (djay Neural Mix/Automix),
**live mixing of licensed streaming catalogs** (Spotify/Apple Music/TIDAL/Beatport),
and **DRM streaming offline lockers** (Beatsource Pro+). All require on-device DSP or
streaming DRM; Offcut only auditions self-hosted AAC proxies via the OS player. Its
offline proxy caching already delivers the "audition offline" UX without any of it.

## Verify-before-relying (post-cutoff competitor specifics)
djay Spotify (restored Sept 2025, desktop-only), OneLibrary (Oct 2025), djay 5.4
16-cue limit, CDJ-3000X cloud services, and all streaming tier names/prices/limits.
rekordbox cloud is currently **Dropbox + Google Drive only** (CloudDirectPlay
Dropbox-only) — so Offcut's Drive relay is at parity.

## Recommended start
**Tier 1.1 + 1.2 (smart playlists + tag categories)** — biggest competitive gap,
fully client-side on already-mirrored data, and the two reinforce each other.
