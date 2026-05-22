# Implementation Plan · Set History Analysis & The Road Not Taken

**Status:** Build plan / architecture
**Authored:** 21 May 2026
**Doc ref:** `id·2026·013`

This is the implementation plan for the feature you described: **when a USB comes back from a gig, OD-01 reads what was actually played, reconstructs the set, and surfaces the tracks you *didn't* play that would have slotted in** — drawing on your own library first, then on publicly-documented sets (1001 Tracklists and similar) to find what other DJs played around those same records, and finally pulling unavailable tracks in via streaming, clearly marked, so you can audition and later buy/download the real file.

Internally this is **"The Road Not Taken"** — a post-gig debrief that treats every set as a draft with alternate takes. It's the brand thesis ("the bits that didn't make it, kept anyway") turned into a working feature, and it's the most novel thing in the whole product. It also has real constraints — two of the obvious data sources turned out to be partly closed — so this plan is built around what's *actually* possible, not what we'd wish.

> **Two hard realities found in research, stated up front, because they shape the whole design:**
> 1. **1001 Tracklists has no official API.** Only unofficial scrapers exist, which violate their terms and break whenever the site changes. We cannot build a shipping feature on covert scraping. The plan routes around this (§4).
> 2. **Spotify's developer API was gutted in Nov 2024.** Recommendations, Audio Features, and Audio Analysis are gone for new apps, and public access now needs steep approval. So "use Spotify to find similar tracks" is dead. Good news: **we have our own analysis pipeline** (`id·2026·010`), which becomes the engine for similarity instead of a third party. This is more work but more durable, and keeps the smarts in-house.

---

## 1 · The shape of the feature

Five stages, each a clean module:

```
  USB returns from gig
        ↓
        ↓
────────────────────  read HISTORY playlists + per-track grids/cues from the
│ 1. RECONSTRUCT   │  Pioneer database (rekordcrate; see id·2026·011). We now
│    THE SET       │  know exactly what was played, in order, with timing.
──────────┬─────────
         ↓
────────────────────  fingerprint + analyse the played tracks. Build the set's
│ 2. PROFILE       │  "shape": BPM arc, key journey, energy curve, the gaps and
│    THE SET       │  jumps. This is what we match candidates against.
──────────┬─────────
         ↓
────────────────────  rank tracks you OWN but didn't play, by how well they'd
│ 3. THE ROAD NOT  │  have slotted into each transition. Local library first —
│    TAKEN (local) │  zero external dependencies, instant, always works.
──────────┬─────────
         ↓
────────────────────  for inspiration beyond your own crate: what did OTHER DJs
│ 4. WIDER FIELD   │  play around these same records? Sourced legitimately
│    (external)    │  (§4), surfaced as suggestions, not certainties.
──────────┬─────────
         ↓
────────────────────  candidates you don't own — audition via streaming,
│ 5. AUDITION &    │  clearly marked STREAMED, with a one-tap path to buy/
│    ACQUIRE       │  download the real file to replace the stream.
────────────────────
```

Stages 1–3 are entirely self-contained and clean — they're the feature's spine and they need nothing external. Stages 4–5 add reach but depend on third parties whose terms we must respect. Build 1–3 first; they're already valuable on their own ("here's what else in your bag would have worked").

---

## 2 · Stage 1 — Reconstruct the set

This is where the CDJ-USB work (`id·2026·011`) pays a dividend. Pioneer players **automatically write a HISTORY playlist** to the USB each time the media is mounted — a numbered, time-ordered record of what was played off that stick (named like `HISTORY 001`). The reverse-engineered format documents these history tables explicitly, and `rekordcrate` can read them.

So reconstruction is mostly free:

- Read the HISTORY playlist(s) — ordered list of played tracks with timestamps.
- For each, pull the track's metadata, beatgrid, and cues from the database and analysis files.
- Derive the **actual transitions**: where one track came in over another, how long the blend was, the BPM/key at each handover.

```typescript
interface PlayedSet {
  source: 'rekordbox-history';
  device: string;
  playedAt: string;
  tracks: PlayedTrack[];       // in play order
  transitions: Transition[];   // derived: A→B handover points
}
interface PlayedTrack {
  trackRef: TrackRef;          // resolves to library or unknown
  startedAt: number;           // seconds into the set
  playedFor: number;           // how long it was up
  beatgrid?: Beatgrid;         // from the stick's analysis files
  meta: TrackMeta;
}
interface Transition {
  fromIndex: number; toIndex: number;
  atTime: number;
  bpmFrom: number; bpmTo: number;
  keyFrom: string; keyTo: string;
  energyFrom: number; energyTo: number;
}
```

The output is a complete, structured record of the night. Even with nothing else, showing the DJ their set back as an editorial "running order" (the `id·2026·012` B2 feature) with the real timings is satisfying and useful.

---

## 3 · Stage 2 — Profile the set, and Stage 3 — The Road Not Taken (local)

### Profiling

Run the played tracks through our own analysis pipeline (`id·2026·010`) to get a consistent feature set — BPM, key, energy, and crucially an **audio embedding** (a vector that captures "what this track sounds like"). The embedding is the key to similarity *without* Spotify: we generate it ourselves from the audio, so no external API is involved.

For embeddings, permissively-licensed options to evaluate:
- **OpenL3** (open-source audio embeddings) or a small **MERT**/**CLAP** audio model exported to ONNX — runs in the same in-process ONNX runtime we're already using for beat detection. MIT/permissive licences; confirm per-model weights as with Beat This!.
- A simpler hand-built feature vector (MFCC + chroma + spectral stats via `essentia`-style DSP) if a learned embedding is overkill for v1.

This produces the **set's shape**: the BPM arc over time, the key journey (as moves around the Camelot wheel), the energy curve, and an embedding per track. The transitions tell us the "joints" where a different choice could have been made.

### The Road Not Taken (local library)

Now the core idea, and the part that always works because it touches nothing external:

For each transition (and each "moment" in the set), score every track **you own but didn't play** on how well it would have slotted in:

- **Harmonic fit** — is it in a compatible key for that point in the journey? (Camelot adjacency, already in our inspector.)
- **Tempo fit** — within mixable BPM range of the surrounding tracks?
- **Energy fit** — does it match the energy the set was at, or provide a wanted lift/drop?
- **Sonic fit** — embedding similarity to the neighbours (so it "belongs" texturally, not just numerically).
- **Freshness** — weighted by provenance (the `id·2026·012` B4 feature): "you haven't played this in 6 months" is a plus; "you play this every set" is a minus.

The output, per moment: a small ranked list of *"tracks in your bag that would have fit here, and why."* This is genuinely useful with zero external dependency — it's a debrief that makes you a better selector using only what you already carry.

```typescript
interface RoadNotTaken {
  moment: number;              // index into the set / transition
  context: { bpm: number; key: string; energy: number };
  candidates: Candidate[];     // ranked
}
interface Candidate {
  trackRef: TrackRef;
  origin: 'library' | 'external-suggestion' | 'streaming';
  scores: { harmonic: number; tempo: number; energy: number; sonic: number; freshness: number };
  reason: string;              // human sentence: "Same key, +1 energy, you haven't played it since March"
  availability: 'owned' | 'streamable' | 'purchasable' | 'unavailable';
}
```

---

## 4 · Stage 4 — The wider field (external sets), done legitimately

Here's where your 1001 Tracklists idea lives — but it has to be done without covert scraping, because there's no official API and scraping violates their terms (and would get the feature, or the app, blocked). Three legitimate routes, in order of preference:

### Route 1 — Official partnership / licensed data (best, slowest)
Approach 1001 Tracklists (or a comparable tracklist database) for a data partnership or licensed API. This is how a real product should consume their data. It's a business-development task, not an engineering one, and it's the only route that's both reliable and clean at scale. Worth initiating early precisely because it's slow.

### Route 2 — User-provided / user-authorised lookups (good, buildable now)
Don't have *the app* crawl. Instead, when the DJ wants to explore the wider field for a specific track, let *them* paste a tracklist URL or pull from sources where access is sanctioned. The app parses what the user explicitly brings, rather than the app silently harvesting a site. This keeps the user in the legal driver's seat (much as a person reading a public webpage is fine; a bot mass-harvesting it is not).

### Route 3 — The LLM as a research assistant (the role your idea really wants)
This is where an LLM genuinely helps, used carefully. Rather than scraping, use an LLM with web access to *research and summarise* — "this record is frequently played alongside X, Y, Z in this style of set" — drawing on its training and sanctioned search, and returning **suggestions to verify**, not authoritative data. Critical framing:
- The LLM proposes *artist + title* candidates, not files.
- Every suggestion is clearly **unverified** until matched (Stage 5).
- It's inspiration ("DJs in this lane often bridge these two with something like…"), not a database query.
- It must not be presented as fact — it's a research lead the DJ confirms.

This is the honest version of "use an LLM to find suitable tracks": the LLM is a knowledgeable assistant suggesting directions, and the system then tries to *find and verify* those suggestions through legitimate channels. It never fabricates availability or pretends a guess is a lookup.

**Design rule for Stage 4:** everything from external/LLM sources is visibly marked as a *suggestion to verify*, in a distinct register from the rock-solid local recommendations of Stage 3. The brand's honesty principle applies — the system says what it knows versus what it's guessing.

---

## 5 · Stage 5 — Audition & acquire (streaming integration)

For a candidate the DJ doesn't own, let them hear it, clearly marked, with a clean path to owning the real file. This is your "pull it in via streaming, mark it as streamed, then download to replace" idea — and the research shows exactly how to build it cleanly.

### Identifying the track: audio fingerprinting (the clean matcher)

To connect "a suggested artist+title" or "a track in someone's set" to an actual catalogue entry, use **AcoustID + Chromaprint** — the open-source audio-fingerprint stack. Chromaprint generates a compact fingerprint from audio; AcoustID matches it to a MusicBrainz recording ID with accurate metadata. It's permissively licensed (LGPL for the library; free web service for non-commercial — confirm commercial terms), fast (~100ms for a 2-minute file), and it's the standard tool (MusicBrainz Picard uses it). This gives us a reliable, canonical identity for a track independent of any one store's metadata.

### Streaming the audition

Route the actual audio through a **DJ-licensed streaming service** — which, post-March-2026, effectively means **Beatport** (Beatsource merged into it). Key facts from research:
- Beatport streaming in DJ software requires an **Advanced or Professional** subscription (the DJ's own account; we integrate, they subscribe).
- It works via **LINK** (offline locker + streaming), the established mechanism other DJ apps use.
- **Streamed tracks carry restrictions** — typically no recording and **no USB export** — which is exactly why the "marked as streamed, replace with a download" flow matters.
- SoundCloud (Go+/DJ) and TIDAL are secondary options some apps support; **Spotify is not a DJ-streaming source** (no DJ licensing, and the API is gutted anyway).

### The "marked as streamed → replace with download" flow

This is the elegant part of your idea, and it maps cleanly onto how streamed tracks already behave:

1. A candidate the DJ doesn't own appears with an `availability: 'streamable'` (or `'purchasable'`) badge — in the catalog-card register, a distinct **STREAMED** stamp (a sibling of the `KEPT` stamp), so it's never mistaken for a track they own.
2. The DJ can audition it inline (within streaming-service rules).
3. If they like it, a one-tap **acquire** action: buy the file from Beatport (or wherever), download it, and the system **swaps the stream for the owned file** — fingerprint-matched so the grid, cues, and the track's place in any saved running order all carry over.
4. Until acquired, the track stays visibly provisional: it can't be exported to a CDJ USB (because streamed tracks can't be), and the UI says so plainly rather than failing at export time.

```typescript
interface AcquireFlow {
  candidate: Candidate;
  identity?: { musicbrainzId: string; isrc?: string };  // from AcoustID
  streamSources: StreamSource[];   // where it can be auditioned
  purchaseSources: PurchaseSource[]; // where the file can be bought
  onAcquired(cb: (ownedTrack: TrackRef) => void): void;  // swap stream → file
}
```

The `STREAMED` marking isn't just a UI nicety — it's enforced through the data model: a streamed track is a *provisional* library entry that's excluded from USB export and flagged everywhere until replaced by a real file. That honesty (you always know what's really yours) is the brand.

---

## 6 · The toolchain, with licences and the real constraints

| Stage | Tool / approach | Licence / terms | Reality check |
|---|---|---|---|
| Read HISTORY | `rekordcrate` (Rust) | confirm | Solid; same as `id·2026·011` |
| Analyse/profile | our pipeline (`id·2026·010`) | permissive | Reuses Beat This! + own DSP |
| Embeddings | OpenL3 / MERT / CLAP via ONNX | permissive*; check weights | *Same weights caveat as Beat This! |
| Identify track | AcoustID + Chromaprint | LGPL lib; web service free non-commercial | **Confirm commercial terms** |
| External sets | partnership > user-provided > LLM-assist | **no 1001TL API; no scraping** | Business-dev task for the clean route |
| LLM suggestions | any web-capable LLM, as *assistant* | per provider | Suggestions to verify, never facts |
| Streaming | Beatport (LINK); maybe SoundCloud/TIDAL | DJ's own paid sub; partner terms | **Spotify is not viable** |
| Purchase | Beatport store | partner terms | The "replace with download" target |

The IP-lawyer list (already holding Rubber Band, Mixxx, Beat-This weights, rekordcrate) gains: **AcoustID commercial terms, Beatport/streaming partner agreements, and the 1001 Tracklists data question.** Of these, the tracklist-data route is the one that most wants a real partnership rather than a clever workaround.

---

## 7 · How it fits the brand

This feature is the brand thesis made literal:

- It's called **The Road Not Taken** — every set has alternate takes that didn't make it.
- Local suggestions are rock-solid and quiet; external/LLM suggestions are clearly marked as leads to verify — the **honesty principle** again (say what you know vs. what you're guessing).
- Owned tracks vs. streamed tracks are unmistakably distinct — the **STREAMED** stamp beside the **KEPT** stamp.
- The whole thing is a *debrief*, an editorial act — you review the night's running order and consider what else belonged. It treats DJing as craft with reflection, not just performance.
- It ties together three existing pieces: the **provenance/history** data (`id·2026·012` B4), the **running order** document (B2), and the **honest, confidence-aware** posture (B1).

---

## 8 · Phasing

**Phase 1 — Reconstruct + show the set (1–2 weeks)**
Read HISTORY via `rekordcrate`, render the played set as an editorial running order with real timings. Milestone: *plug in a used stick, see your night played back.*

**Phase 2 — Profile + local Road Not Taken (3–4 weeks)**
Analyse played tracks, build the set shape, score the owned-but-unplayed library against each moment. Milestone: *"here are tracks from your own bag that would've fit here, and why."* This is the feature's heart and it's fully self-contained.

**Phase 3 — Audio identity + streaming audition (3–4 weeks)**
AcoustID/Chromaprint matching; Beatport LINK integration for audition; the STREAMED stamp and the provisional-entry data model. Milestone: *audition a suggested track you don't own, clearly marked, can't-yet-export.*

**Phase 4 — Acquire & replace (2–3 weeks)**
The buy-and-swap flow: purchase → download → fingerprint-match → replace the stream with the owned file, carrying grid/cues across. Milestone: *one tap turns a streamed suggestion into an owned, gig-ready track.*

**Phase 5 — The wider field (gated on the data route)**
LLM-assisted suggestions (as verify-me leads) now; the legitimate tracklist-data partnership when/if it lands. Milestone: *"other DJs in this lane often went here next" — clearly as suggestion, verified through clean channels.*

To the genuinely useful core (Phases 1–2): ~4–6 weeks, entirely clean and self-contained. The streaming/acquire reach (3–4) adds a few more weeks and depends on partner terms. The wider-field (5) is partly a business-development timeline, not just engineering.

---

## 9 · What to hand Claude Code first

1. **Phase 1 + the `PlayedSet` model** — read HISTORY via the (already-planned) `rekordcrate` wrapper, render the set as a running order. Reuses the export plan's reader and the design system's running-order UI.
2. **The local Road Not Taken scorer (Phase 2)** — pure logic over the contract: harmonic + tempo + energy + embedding + freshness scoring, against a mock library with mock embeddings. Fully testable, no external calls, no streaming.
3. **The provisional-entry / STREAMED data model** — define how a streamed track differs from an owned one (excluded from export, visibly marked) before any streaming API is wired, so the honesty is structural from day one.

That builds the entire self-contained core — reconstruct, profile, suggest-from-your-own-bag — before touching a single external API, exactly the pattern of every other plan: front-load the clean, valuable, dependency-free part; isolate the partner-dependent reach behind interfaces.

---

## 10 · The honest summary

The core of your idea — *plug the stick back in, see what you played, and discover what else in your bag would have fit* — is buildable, clean, novel, and on-brand, with **zero external dependencies**. It rides entirely on work already planned (HISTORY reading from `id·2026·011`, analysis from `id·2026·010`, the running-order and provenance features from `id·2026·012`). Build this first; it's the part that's unambiguously yours and unambiguously good.

The reach beyond your own library is where reality bites, and I'd rather be straight about it now than have it break later:
- **1001 Tracklists has no API and scraping isn't a shippable foundation** — the clean route is a data partnership, with LLM-as-research-assistant (suggestions to verify) as the honest interim.
- **Spotify can't be the similarity engine** (API gutted) — so we use our *own* analysis/embeddings, which is more work but more durable and keeps the intelligence in-house.
- **Streaming/audition routes through Beatport** (post-merger), on the DJ's own subscription, with streamed tracks structurally marked and export-blocked until replaced by a real file — which is exactly the flow you described.

The feature that results is arguably OD-01's signature: a post-gig debrief that makes you a better selector, treats your library as an archive with memory, and is honest at every step about what it knows, what it's guessing, and what you actually own.
