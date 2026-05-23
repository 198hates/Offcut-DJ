# DJ Software Feature Audit — Crate vs the Field

Reference sweep against: **Rekordbox 7**, **Serato DJ Pro 3**, **Traktor Pro 4**,
**Engine DJ 4**, **djay Pro AI**, **Virtual DJ 2024**, **Mixxx 2.4**, **Lexicon DJ**.

Last updated: 2026-05-23

Legend · ✓ Done · ~ Partial · — Not present

---

## 1. Player / Deck

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Hot cues (8 per deck) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Loop In / Out / Toggle | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Beat Loops (1/2/4/8 bars) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Playback rate / pitch fader | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| MIDI controller mapping | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| EQ (Hi / Mid / Low) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Crossfader | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Waveform display | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | 3-band / RGB / gradient |
| Beatgrid editor | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| **Beat Jump** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Jump ±1/2/4/8/16/32 beats; CDJ-essential |
| **Slip / Flux Mode** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Playhead advances under loops/cues |
| **Quantize Mode** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Cues/loops snap to beatgrid |
| **Keylock (independent key+tempo)** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Needs Web Audio pitch-shift node |
| **Auto-gain / Loudness normalise** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Per-track gain trim; store as `gainDb` |
| **Loop Roll / Reloop** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Hold → loop, release → jump ahead |
| **Saved loops (named loop slots)** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | 8 named slots, persist to DB |
| **Beat Jump (shift ±1 beat)** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Fine grid nudge |
| **Pitch range selector** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | ±4 / ±8 / ±16 / ±50 % |
| **Spinback / Brake effect** | ✓ | ✓ | — | ✓ | — | ✓ | — | **—** | Simulated vinyl brake |
| **Per-deck FX chain** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Reverb, delay, echo, filter, flanger |
| **Sampler decks** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | 8-pad one-shot/loop sampler |
| **Mix recording** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Record output to WAV/AIFF |
| **Open Key notation** | ✓ | — | ✓ | ✓ | — | — | — | **—** | Toggle Camelot ↔ Open Key ↔ Standard |
| **Pre-listen (headphone cue)** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Route one deck to a second audio output |
| **Scratch / Jog wheel simulation** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Low priority without physical hardware |
| **Ableton Link** | — | — | ✓ | — | ✓ | ✓ | ✓ | **—** | Sync tempo to other Link-enabled apps |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P1 | **Beat Jump** | Present in every competing product; CDJ muscle memory | 0.5 d |
| P1 | **Quantize Mode** | Essential for tight live performance | 0.5 d |
| P1 | **Slip Mode** | Every modern CDJ/controller has this | 1 d |
| P2 | **Keylock** | Pitch-shift AudioNode in Web Audio (computationally cheap) | 1.5 d |
| P2 | **Auto-gain** | Loudness analysis stores a `gainDb` trim — big QoL | 1 d |
| P2 | **Pitch range selector** | Tiny UI, big workflow impact for varied BPM libraries | 0.5 d |
| P2 | **Loop Roll** | Common on NXS2/SC6000 — frequently used | 1 d |
| P3 | **Saved loops** | Named 8-slot loop storage per track | 1 d |
| P3 | **Per-deck FX chain** | 4–6 effects via Web Audio nodes | 3 d |
| P3 | **Mix recording** | Record master out to WAV — Electron media capture | 2 d |
| P4 | **Sampler decks** | Full 8-pad sampler is a significant scope addition | 5 d |
| P4 | **Pre-listen** | Needs second audio output device selection | 2 d |
| P4 | **Open Key notation** | Toggle in settings, pure display change | 0.5 d |

---

## 2. Library / Organisation

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Track metadata (BPM, Key, Rating, etc.) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Smart / Dynamic playlists | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | 14+ fields |
| Playlist folders / nesting | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Track colour tags | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | **✓** | |
| Custom user tags / fields | ✓ | ~ | ~ | ~ | — | ✓ | ~ | **✓** | |
| Bulk metadata editor | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Smart Fixes / auto-correct metadata | — | — | — | — | — | ✓ | — | **✓** | 15+ algorithms |
| Watch folder / auto-import | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Duplicate scanner | ✓ | — | — | ✓ | — | ✓ | — | **✓** | |
| Missing file scanner + auto-locate | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Path remapping (root relocation) | — | — | — | ✓ | — | ✓ | ✓ | **✓** | |
| Write tags back to file | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Play count + last played | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Edit lineage (track relationships) | — | — | — | — | — | — | — | **✓** | Unique to Crate |
| Running orders / programme docs | — | — | — | — | — | — | — | **✓** | Unique to Crate |
| Set builder with BPM arc + graph | ~ | ~ | ~ | ~ | — | ~ | — | **✓** | Unique depth |
| Advanced search (multi-dim) | ~ | ~ | ✓ | ~ | — | ✓ | ✓ | **✓** | |
| Compass scatter-map | — | — | — | — | — | — | — | **✓** | Unique to Crate |
| **Artwork column in library grid** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | 40×40 thumbnail in row |
| **Mini waveform / stripe in library** | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | **—** | Serato "Stripe", RB overview |
| **History / Session playlists** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Auto-playlist of what played each session |
| **File info columns** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | File type, size, sample rate, bit depth |
| **Column visibility toggle** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Per-user column show/hide |
| **Multi-column sort** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | e.g. sort by Energy then BPM |
| **Playlist merge** | — | ✓ | ✓ | ✓ | — | ✓ | — | **—** | Union two playlists → new playlist |
| **Playlist shuffle** | — | ✓ | — | ✓ | — | ✓ | — | **—** | Fisher-Yates on trackIds |
| **Playlist cross-reference (diff)** | — | ✓ | ✓ | ✓ | — | ✓ | — | **—** | "Tracks in A not in B" |
| **Folder track count + total time** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Recursive count in sidebar |
| **Library statistics dashboard** | ✓ | ~ | ~ | ✓ | — | ✓ | — | **~** | Have Health stats; no charts |
| **Date modified field** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | `updatedAt` on track |
| **BPM confidence indicator** | — | — | — | — | — | — | ✓ | **—** | Show analysis confidence score |
| **Plays per day / heatmap** | ✓ | — | — | — | — | — | — | **—** | GitHub-style calendar heatmap |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P1 | **History / Session playlists** | Universal across all software; tells you what you played | 1 d |
| P1 | **Column visibility toggle** | Power users hide clutter; present in every competitor | 1 d |
| P1 | **Multi-column sort** | Sort BPM then Key is standard DJ workflow | 0.5 d |
| P2 | **Artwork column in library** | Visual anchor; RB/Serato users expect this | 1 d |
| P2 | **File info columns** | File type, size, bit depth, sample rate — present everywhere | 0.5 d |
| P2 | **Playlist merge / shuffle / diff** | Playlist tools — small, very requested | 1 d |
| P2 | **Folder track count + total time** | Sidebar polish — shows at a glance | 0.5 d |
| P2 | **Date modified field** | Helps spot recently edited tracks | 0.5 d |
| P3 | **Mini waveform stripe in library** | Visually rich; RB/Serato icon feature | 2.5 d |
| P3 | **Plays per day heatmap** | Full play history already stored | 1 d |

---

## 3. Analysis

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| BPM detection | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | Essentia + Beat This! ONNX |
| Key detection (Camelot) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | |
| Energy / Valence analysis | ~ | ~ | ~ | ~ | — | ~ | — | **✓** | 1–10 scale |
| Mood analysis | ~ | — | — | — | — | — | — | **✓** | −1.0 → +1.0 valence |
| Danceability | — | — | — | — | — | — | — | **✓** | 0–1 score |
| Genre suggestion | — | — | — | — | — | — | — | **✓** | ML classifier |
| Full beatgrid (beats + bars) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | v2 Beatgrid type |
| Auto-cue generation | ~ | — | — | ~ | — | — | — | **✓** | Energy-based transient detection |
| Phrase analysis (intro/verse/chorus etc.) | ✓ | — | — | — | — | — | — | **—** | Rekordbox 7 "PHRASE" analysis |
| **Auto-analyse on import / watch folder** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | BPM+key triggered when file added |
| **Loudness / LUFS analysis** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Integrated LUFS → auto-gain trim |
| **Waveform thumbnail stored per-track** | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | **—** | Pre-computed peak array stored in DB |
| **Stem separation** | — | — | ✓ | — | ✓ | ✓ | — | **—** | Vocals / drums / bass / melody split |
| **AcoustID / MusicBrainz fingerprint** | — | — | — | — | — | — | ✓ | **—** | Fill missing metadata from fingerprint |
| **Beatport metadata lookup** | ✓ | ✓ | — | — | — | ✓ | — | **—** | Fetch label/ISRC/release data |
| **ReplayGain analysis** | — | — | ✓ | — | — | — | ✓ | **—** | Standard loudness norm format |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P1 | **Auto-analyse on import** | Watch folder adds files → they should auto-analyze | 1 d |
| P1 | **Loudness / LUFS analysis** | Needed for auto-gain; data already used once RB7 has it | 1.5 d |
| P2 | **Stored waveform thumbnails** | Enables mini-waveform stripe in library | 1.5 d |
| P2 | **Phrase analysis** | Rekordbox-exclusive right now; differentiation | 4 d |
| P3 | **AcoustID fingerprint lookup** | Fill missing metadata — great for untagged collections | 2 d |
| P4 | **Stem separation** | Demucs/Spleeter — heavy ML, significant scope | 6 d |

---

## 4. Integrations (Import / Export / Sync)

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Rekordbox XML import | ✓ | — | — | — | — | — | — | **✓** | |
| Rekordbox master.db import | ✓ | — | — | — | — | — | — | **✓** | SQLCipher |
| Rekordbox export | ✓ | — | — | — | — | — | — | **✓** | |
| Serato GEOB import | — | ✓ | — | — | — | — | — | **✓** | |
| Serato export | — | ✓ | — | — | — | — | — | **✓** | |
| Traktor NML import | — | — | ✓ | — | — | — | — | **✓** | |
| Traktor export | — | — | ✓ | — | — | — | — | **✓** | |
| Engine DJ import | — | — | — | ✓ | — | — | — | **✓** | |
| Engine DJ export | — | — | — | ✓ | — | — | — | **✓** | |
| Apple Music XML import | — | — | — | — | ✓ | — | — | **✓** | |
| VirtualDJ export | — | — | — | — | — | ✓ | — | **✓** | |
| M3U export | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| CSV export | ✓ | ✓ | — | — | — | ✓ | — | **✓** | |
| PDF running order export | — | — | — | — | — | — | — | **✓** | |
| Write ID3/FLAC tags to file | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| ProLink B2B capture (Pioneer network) | ✓ | — | — | — | — | — | — | **✓** | |
| Pioneer USB history reader | ✓ | — | — | — | — | — | — | **✓** | |
| **Export to Pioneer CDJ USB** | ✓ | — | — | — | — | — | — | **—** | PIONEER/ folder format; complex |
| **Beatport link / browse** | ✓ | ✓ | — | — | — | ✓ | — | **—** | OAuth; streaming metadata |
| **TIDAL / SoundCloud import** | — | ✓ | — | ✓ | ✓ | ✓ | — | **—** | Streaming library browsing |
| **Discogs metadata fetch** | — | — | — | — | — | — | — | **—** | Label / year / genre from Discogs API |
| **Engine Cloud sync** | — | — | — | ✓ | — | — | — | **—** | Denon cloud service |
| **iTunes / Music.app two-way sync** | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | **—** | Write back playlists to Music.app |
| **Cue Sheet (.cue) export** | — | — | — | — | — | ✓ | — | **—** | Standard cue sheet for session logs |
| **DJUCED / Hercules export** | — | — | — | — | — | — | — | **—** | Niche but simple XML |
| **OSC control** | — | — | ✓ | — | — | — | ✓ | **—** | TouchOSC / Lemur integration |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P2 | **iTunes two-way sync** | Write playlists back to Music.app; close loop with Apple Music import | 1.5 d |
| P2 | **Cue Sheet export** | Exportable session log for gig documentation | 0.5 d |
| P2 | **Discogs metadata fetch** | Fill label/year/genre on untagged tracks — no OAuth needed | 1.5 d |
| P3 | **Export to Pioneer CDJ USB** | High demand from club DJs; significant engineering | 5 d |
| P4 | **Beatport integration** | OAuth dependency; changing API | 4 d |
| P4 | **TIDAL / SoundCloud** | OAuth + licensing complexity | 5 d |

---

## 5. Connectivity

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| MIDI controller mapping | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** | Learn mode |
| ProLink B2B capture | ✓ | — | — | — | — | — | — | **✓** | |
| Pioneer USB history read | ✓ | — | — | — | — | — | — | **✓** | |
| HID controller support | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Native USB HID (Rane, Pioneer) |
| DVS / Timecode vinyl | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | **—** | Serato/Traktor timecode records |
| Ableton Link | — | — | ✓ | — | ✓ | ✓ | ✓ | **—** | |
| OSC | — | — | ✓ | — | — | — | ✓ | **—** | |
| Streaming / broadcasting | — | — | — | — | — | ✓ | ✓ | **—** | Shoutcast/Icecast |
| MIDI clock out | — | — | ✓ | — | — | ✓ | ✓ | **—** | Sync external gear to deck BPM |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P3 | **Ableton Link** | Growing standard; producers + DJs sync apps | 2 d |
| P4 | **HID support** | Needs native Electron module; significant scope | 5 d |
| P4 | **DVS** | Specialist use case; out of scope currently | 8+ d |

---

## 6. Session Management

| Feature | RB | Serato | Traktor | Engine | djay | VDJ | Mixxx | **Crate** | Notes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Play count + last played | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **✓** | |
| Cut history (mixedFrom / mixedInto) | — | — | — | — | — | — | — | **✓** | Unique to Crate |
| ProLink session capture | ✓ | — | — | — | — | — | — | **✓** | |
| Pioneer USB set history | ✓ | — | — | — | — | — | — | **✓** | |
| Running orders / programme export | — | — | — | — | — | — | — | **✓** | PDF export |
| Play history chart | ✓ | — | — | ✓ | — | — | — | **~** | Health page has basic chart |
| **Session / History playlist (auto)** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | **—** | Auto-playlist per session |
| **Calendar heatmap of plays** | ✓ | — | — | — | — | — | — | **—** | GitHub-style 52-week view |
| **Mix recording** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **—** | Record output to audio file |
| **Setlist / gig history log** | ✓ | ✓ | — | — | — | ✓ | — | **—** | Searchable past-gig archive |
| **Broadcasting** | — | — | — | — | — | ✓ | ✓ | **—** | Shoutcast/Icecast stream |

**Priority for Crate:**

| # | Feature | Why | Effort |
|---|---|---|---|
| P1 | **Session history playlist** | Auto-generate "played today" playlist each session | 1 d |
| P2 | **Calendar heatmap** | Play data already stored; visual polish | 1 d |
| P2 | **Mix recording** | Record to WAV — Electron `desktopCapturer` or Web Audio recorder | 2 d |
| P3 | **Gig history log** | Archive past sessions with ProLink + USB data | 1.5 d |
| P4 | **Broadcasting** | Icecast/Shoutcast — out of scope for library tool | 4 d |

---

## 7. Summary: Unique Crate Strengths

Features Crate has that **no competing product offers** (or significantly deeper than):

| Feature | Notes |
|---|---|
| **Edit lineage** | Track → original recording → version label links |
| **Cut history** | mixedFrom / mixedInto per play, B2B chain reconstruction |
| **Running orders** | Editorial programme documents with PDF export |
| **Set builder** — BPM arc canvas | Three-lens arc view (BPM, Energy, Keys) per chapter |
| **Compass scatter-map** | 2D plot with lasso select and Camelot colour coding |
| **Smart Fixes** | 15 automated metadata correction algorithms |
| **ProLink B2B capture** | Real-time CDJ network monitoring with library matching |
| **Beatgrid v2** (beats + bars) | Richer than any competitor's exported format |
| **Mood / danceability** | Stored fields with scatter-map integration |

---

## 8. Consolidated Priority Backlog

Ranking by `(universality × workflow impact) / effort`:

### Tier 1 — Small effort, universal presence (do next)

| # | Feature | Category | Effort |
|---|---|---|---|
| 1 | **Beat Jump** (±1, ±2, ±4, ±8, ±16, ±32 beats) | Player | 0.5 d |
| 2 | **Quantize Mode** (cues/loops snap to grid) | Player | 0.5 d |
| 3 | **Multi-column sort** in library | Library | 0.5 d |
| 4 | **Session history playlist** (auto per-session) | Session | 1 d |
| 5 | **Column visibility toggle** | Library | 1 d |
| 6 | **Pitch range selector** (±4/8/16/50%) | Player | 0.5 d |
| 7 | **Folder track count + total time** in sidebar | Library | 0.5 d |
| 8 | **File info columns** (type, size, bitdepth, sample rate) | Library | 0.5 d |
| 9 | **Auto-analyse on import** (watch folder → BPM+key) | Analysis | 1 d |
| 10 | **Open Key notation toggle** | Player/Library | 0.5 d |

### Tier 2 — Medium effort, high competitive parity

| # | Feature | Category | Effort |
|---|---|---|---|
| 11 | **Slip Mode** | Player | 1 d |
| 12 | **Keylock** (independent key + tempo) | Player | 1.5 d |
| 13 | **Auto-gain / LUFS analysis** | Analysis | 1.5 d |
| 14 | **Loop Roll / Reloop** | Player | 1 d |
| 15 | **Artwork column in library grid** | Library | 1 d |
| 16 | **Playlist merge / shuffle / diff** tools | Library | 1 d |
| 17 | **Date modified field** | Library | 0.5 d |
| 18 | **Calendar heatmap** (play history) | Session | 1 d |
| 19 | **Cue Sheet export** | Integration | 0.5 d |
| 20 | **iTunes two-way sync** | Integration | 1.5 d |
| 21 | **Discogs metadata fetch** | Integration | 1.5 d |
| 22 | **Saved loops** (8 named slots per track) | Player | 1 d |

### Tier 3 — Significant work, strong differentiation

| # | Feature | Category | Effort |
|---|---|---|---|
| 23 | **Mix recording** (WAV output) | Session | 2 d |
| 24 | **Per-deck FX chain** | Player | 3 d |
| 25 | **Mini waveform stripe in library** | Library | 2.5 d |
| 26 | **Phrase analysis** (song structure detection) | Analysis | 4 d |
| 27 | **AcoustID / MusicBrainz fingerprint** | Integration | 2 d |
| 28 | **Pre-listen / headphone cue** | Player | 2 d |
| 29 | **Ableton Link** | Connectivity | 2 d |
| 30 | **Stored waveform thumbnails** in DB | Analysis | 1.5 d |

### Tier 4 — Out of scope / future

| Feature | Reason |
|---|---|
| Export to Pioneer CDJ USB | Complex PIONEER/ directory format; fragile with firmware updates |
| Stem separation | Heavy ML (Demucs) — needs native binary or cloud backend |
| DVS / timecode vinyl | Specialist hardware path; outside library-manager scope |
| HID native controller support | Requires platform-specific native module |
| Broadcasting (Shoutcast/Icecast) | Outside library-manager scope |
| Beatport / TIDAL streaming | OAuth + licensing; ongoing API maintenance burden |
| Video mixing | Separate product category |
| Mobile app | Separate React Native codebase |
