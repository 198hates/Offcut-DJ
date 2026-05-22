# Implementation Plan · Live ProLink Capture & B2B History

**Status:** Build plan / architecture — BLOCKED on `id·2026·013`
**Authored:** 21 May 2026
**Doc ref:** `id·2026·016`

This plan covers reading the **Pioneer DJ Link / ProLink** network live during a set, so OD-01 can capture *everything both players do* in a back-to-back — including the tracks the other DJ plays that aren't in your own library — with full metadata read directly off their media over the network.

It exists because of a specific, real frustration: **Rekordbox's own history only records what played on "your" side of a B2B.** The other DJ's selections vanish. But the data is already on the wire — ProLink continuously broadcasts what every player is doing — so a piece of software that joins the network can see the whole night. This is the fix.

It's the strongest capture mode for the set-history feature (`id·2026·013`): where the USB-history approach sees only your half after the fact, live ProLink capture sees both halves as they happen, with metadata for tracks you don't own.

> **Reality, stated up front (all verified against current tooling):**
> 1. **The protocol is reverse-engineered and has mature libraries** — three independent implementations, one (`prolink-connect`) in TypeScript, which drops into our stack. We're integrating, not reverse-engineering.
> 2. **Metadata for a track is read from the device it was loaded from** — including the *other* DJ's USB. This is the mechanism that makes "even if it's not in your library" work.
> 3. **It's unsanctioned.** Not a Pioneer-blessed API. It can break on firmware updates and misbehaves on non-compliant units. Build defensively, test on real hardware, fail gracefully — same discipline as the USB-export work.
> 4. **It needs a wired network presence at the gig.** A laptop on the same ProLink ethernet switch as the players. That's normal for streaming overlays, but it defines this as a "connected during the set" feature, complemented by the post-gig USB mode.

---

## 1 · What ProLink actually gives us

Pioneer CDJ/XDJ players (and DJM mixers) on a ProLink network announce themselves and broadcast continuously over UDP, with metadata queryable over TCP. By joining as a **virtual CDJ** — a software device that participates in the protocol — OD-01 can both listen and query.

Two distinct data channels:

### Status packets (UDP, ~300ms, broadcast)
Every player emits a status packet several times a second. From *every* player on the network — including the other DJ's — we get live:
- which track is loaded (as a reference: player number, source slot, and the track's rekordbox database ID),
- BPM and current pitch/tempo,
- play state (playing/cued/stopped/looping),
- **on-air status** (is this channel actually audible through the mixer?),
- sync/master state, beat position within the bar.

This is enough to know, continuously, *what both decks are doing* and *which one the crowd is actually hearing*.

### Metadata queries (TCP, on demand)
The status packet gives a *reference*, not the title. To get the human metadata, the virtual CDJ opens a TCP connection **to the device the track was loaded from** and queries its database — pulling title, artist, album, key, BPM, genre, comment, catalogue number, and even the beatgrid and waveform.

**This is the crux for the B2B case:** the metadata lives on the other DJ's USB, and ProLink lets us read it from their media over the network. We do *not* need the track in our own library. There's also a documented variant for non-rekordbox tracks (even CD-audio in a CD slot), so unanalysed material still yields basic metadata.

---

## 2 · Architecture — the virtual CDJ

```
        ProLink ethernet switch (at the gig)
                    │
   ────────────┬────┴────┬────────────
   ▼            ▼        ▼             ▼
 CDJ-1        CDJ-2     DJM         OD-01 laptop
 (you)      (other DJ)  mixer       = VIRTUAL CDJ
                                     │
                          ────────────┴────────────
                          │  prolink-connect (TS) │
                          │  · device discovery    │
                          │  · status monitor      │
                          │  · remoteDB metadata   │
                          ────────────┬────────────
                                     ▼
                          ────────────────────────
                          │  Capture engine        │
                          │  · dedupe + debounce   │
                          │  · on-air gating       │
                          │  · "played" detection  │
                          ────────────┬────────────
                                     ▼
                          ────────────────────────
                          │  PlayedSet (live)      │  ← same model as id·2026·013
                          │  both decks, metadata  │
                          │  sourced per-track     │
                          ────────────────────────
```

OD-01 runs as one virtual device on the network. It listens to all players' status, and when a track becomes "played" (see §3), it queries that track's source device for metadata and appends to the live `PlayedSet`. The same `PlayedSet` structure the post-gig USB reader produces (`id·2026·013` §2) — so everything downstream (profiling, Road Not Taken, provenance) works identically whether the set was captured live or read off a stick.

### The library
- **`prolink-connect`** (TypeScript) — primary. Native to our stack: device discovery, `CDJStatus` monitoring, and the `remoteDB` metadata client. Confirm its licence and pin the version (the protocol research notes things shift with firmware).
- Fallbacks/reference: `prolink-go` (Go) and the Deep Symmetry `beat-link` (Java) — useful for cross-checking behaviour, not for shipping in an Electron app.
- The Deep Symmetry **DJ Link Ecosystem Analysis** is the canonical protocol documentation if we ever need to go below the library.

---

## 3 · The capture logic (where the craft is)

Raw status packets aren't a tracklist. Turning "deck 2 has track X loaded" into "the other DJ played X at 01:14 for 5 minutes" needs judgement:

### "Played" detection
A track is only *played* if it was actually heard, not merely loaded and previewed. Combine signals:
- **On-air status** from the mixer — was this channel open to the master?
- **Play state** — was it playing, not just cued?
- **Duration threshold** — sustained for more than a few beats (debounce loads, scratched-past tracks, quick auditions).
- **Beat counting** — the streaming overlays use "playing + on-air + N beats elapsed" as the bar for "this counts." We use the same.

This mirrors how the established overlay tools decide when to display a track — they deliberately delay until the track is genuinely playing, to avoid flashing every cue-preview on screen. We apply the same gate before committing to history.

### Metadata sourcing + marking
When a track passes the gate:
- Query its source device for full metadata.
- Resolve `trackRef` against our own library by fingerprint/IDs. If it's ours, link it. If not — the B2B case — keep it as an **external played track**: full metadata, but flagged `sourcedFrom: 'prolink'` and `inLibrary: false`.
- These external tracks are exactly the ones the DJ couldn't otherwise see. They feed straight into the acquire flow (`id·2026·013` §5): fingerprint-matchable, auditionable via streaming, buyable to own.

### Attribution (whose track was it?)
In a B2B, "which deck" maps loosely to "which DJ." We can record per-track *which player* it came from, so the history distinguishes your selections from theirs — optionally labelled with DJ names if the session is set up that way. This is the thing Rekordbox can't do at all.

```typescript
interface ProLinkCapture {
  start(iface: NetworkInterface): Promise<void>;   // join as virtual CDJ
  onPlayed(cb: (t: CapturedTrack) => void): void;
  onStatus(cb: (s: PlayerStatus[]) => void): void;  // live, all decks
  stop(): Promise<PlayedSet>;                        // finalise the night
}
interface CapturedTrack extends PlayedTrack {
  player: number;                  // which CDJ
  attributedTo?: string;           // "DJ A" / "DJ B" if labelled
  sourcedFrom: 'prolink';
  inLibrary: boolean;              // false = the B2B case
  metadata: TrackMeta;             // read off the source device
  beatgrid?: Beatgrid;             // also available over ProLink
}
```

---

## 4 · The constraints, and how we handle each

| Constraint | Detail | Handling |
|---|---|---|
| **Slot economy** | The virtual CDJ takes a player ID (1–4). Reading USB metadata works with ≤3 real CDJs; a 4th limits you to Rekordbox-linked metadata only. | Auto-assign a safe ID; detect crowding and warn. For a 2-deck B2B (the core case) this never bites. |
| **Unsanctioned** | Reverse-engineered; can change with firmware; some units misbehave. | Defensive coding, version-pinned library, graceful degradation, real-hardware test matrix. Never assume a packet shape. |
| **Network presence** | Needs a laptop on the ProLink ethernet switch. | Frame honestly as "connected capture." Pair with the post-gig USB mode (§6) for when you didn't bring a laptop. |
| **Lite units** | XDJ-RX/RX2 use "Link Export" and can't exchange LINK data with other players. | Detect non-participating gear; tell the user this setup can't be live-captured rather than failing silently. |
| **ID conflict / Rekordbox running** | The library fails if Rekordbox runs on the same machine or an ID collides. | Pre-flight network check; clear error if Rekordbox is open or the network's full. |
| **Firmware drift** | New CDJ firmware could change packet formats. | Treat the library version as a tested dependency; validate against the players you claim to support; surface "untested firmware" warnings. |

The throughline, same as USB export: **fail loudly at setup, never silently mid-set.** A pre-flight network check tells the DJ "OD-01 is on the network, sees 2 players, capture is live" *before* the set starts — so there's no nasty surprise where the history turns out empty afterward.

---

## 5 · How it extends set-history analysis (`id·2026·013`)

This is the same feature, with a better data source for the B2B case. Nothing downstream changes:

- The live `PlayedSet` is identical in shape to the USB-read one, so **profiling, the Road Not Taken scorer, and provenance all just work** — now over the *whole* B2B, both DJs' tracks included.
- The "Road Not Taken" gets richer: you can analyse what *you* could have dropped in response to what *they* played — answering *what they did to your selections* and *what would have answered theirs.*
- External tracks (the other DJ's, not in your library) are first-class: clearly marked, fingerprint-matched, auditionable and acquirable through the streaming flow (`id·2026·013` §5). The B2B becomes a *discovery* surface — "what was that the other DJ dropped at the peak?" answered automatically.
- Provenance (`id·2026·014` F3) gains B2B context: a play event can record `mixedFrom`/`mixedInto` *across DJs*, and even who you played alongside.

So this plan is really "a second, superior capture source feeding the existing pipeline" — not a separate feature. Build the pipeline once (`id·2026·013`), feed it from USB and from ProLink.

---

## 6 · Two capture modes, complementary

- **Live ProLink capture (this plan):** laptop on the network during the set. Sees *both* decks, full metadata for tracks you don't own, real-time. The B2B answer. Needs gear + connection.
- **Post-gig USB history (`id·2026·013` §2):** read your stick's HISTORY afterward. Simpler, no laptop-at-gig, but only your half.

Offer both. The USB mode is the everyday fallback; live ProLink is the power mode for B2Bs and for DJs who already run a laptop for streaming/overlays. They produce the same `PlayedSet`, so the user experience downstream is identical — only the completeness differs.

---

## 7 · Licensing & ethics

- **The protocol libraries** (`prolink-connect` et al.) have their own licences — confirm and record in `LICENSES.md`. Most of this ecosystem is permissively licensed, but verify per-library.
- **Interoperating with a network protocol**, like a file format, is not itself a copyright issue — we're a device speaking a protocol, not copying anyone's code. We keep our own implementation/wrapper and don't lift GPL source.
- **The unsanctioned nature** is a stability/support risk, not a legal-Mixxx-style risk. Document it for the user (and the lawyer list) honestly: "live capture relies on reverse-engineered protocol support and may be affected by Pioneer firmware updates."
- **Metadata ethics:** reading what's playing on a shared network at a gig you're part of is the same data the streaming-overlay tools already surface. We're not exfiltrating anything private — it's the public state of the booth you're performing in. Still, attributing tracks to a named other DJ is something to keep user-controlled (label the session deliberately; don't silently build a dossier).

This goes on the IP/risk list alongside the others, but like the format-interop work, it's a comparatively clean item — the risk is "firmware might change," not "we copied someone's code."

---

## 8 · Phasing

**Phase 1 — Join & observe (1–2 weeks)**
Integrate `prolink-connect`, bring the virtual CDJ online, render a live device-status panel (both decks: BPM, play state, on-air). No history yet. Milestone: *plug into a ProLink network, see both players' live status in OD-01.*

**Phase 2 — Metadata queries (1–2 weeks)**
Query source devices for the loaded tracks' metadata, including the *other* deck's USB. Milestone: *see the title/artist/key of what's on the other DJ's deck, with the track not in your library.*

**Phase 3 — Capture logic → PlayedSet (2–3 weeks)**
The "played" gate (on-air + play state + duration + beats), dedupe, per-deck attribution, and emit the same `PlayedSet` as the USB reader. Milestone: *capture a full B2B as a clean, ordered history with both DJs' tracks.*

**Phase 4 — Pre-flight + resilience (1–2 weeks)**
Network check, ID assignment, Rekordbox-running detection, non-compliant-gear detection, graceful degradation, "capture is live" confirmation before the set. Milestone: *the DJ knows before the set that capture is working — no empty-history surprises.*

**Phase 5 — Real-hardware matrix (2–3 weeks + ongoing)**
Test across CDJ-2000NXS2 / CDJ-3000 / XDJ models and firmwares; document what's supported; handle the lite units. Milestone: *verified live capture on real club setups.*

**Phase 6 — Fold into set-history**
Route the live `PlayedSet` into the existing pipeline (`id·2026·013`). External-track acquire flow, B2B Road Not Taken, cross-DJ provenance. Milestone: *a captured B2B feeds the full debrief, with the other DJ's unowned tracks auditionable and acquirable.*

To live B2B capture producing a usable history (Phases 1–3): ~4–7 weeks. Hardening + hardware testing (4–5) is the part you can't shortcut, as with all the protocol work. Phase 6 is mostly wiring, since the pipeline already exists.

---

## 9 · What to hand Claude Code first

1. **Phase 1 against `prolink-connect`** — virtual CDJ online + a live status panel in the Offcut register (both decks as instrumented readouts). Needs a network with players, or the library's simulation/fixtures for dev.
2. **The capture-logic module** — pure logic turning a stream of status packets into `CapturedTrack` events, testable against recorded/mock packet streams with no hardware. The "played" gate is the interesting, testable bit.
3. **The pre-flight network check UI** — the "capture is live, 2 players seen" confirmation screen, in the design language, so the resilience story is built in from the start rather than bolted on.

The mockable parts (capture logic, UI) build and test without a booth full of CDJs; the real-hardware validation is isolated to its own phase — the same pattern as every other plan.

---

## 10 · The honest summary

Your instinct was exactly right: the data is on the wire, and reading it is a solved problem. ProLink continuously broadcasts what every player is doing, a virtual CDJ can join and listen, and — critically — **track metadata is read from the device each track was loaded from, including the other DJ's USB.** That's what makes "see the other DJ's tracks even when they're not in your library" genuinely achievable, with a TypeScript library that fits our stack.

This turns the set-history feature from "your half, after the fact" into "the whole B2B, live" — and makes the other DJ's selections a discovery surface: identify them, audition them, own them. It's the same downstream pipeline as `id·2026·013`, fed by a better source.

The honest caveats are the ordinary ones for unsanctioned protocol work — needs a laptop on the network, relies on reverse-engineered support that firmware could change, and wants real-hardware testing across player models. None is a blocker; all are "build defensively and test on real gear," exactly like the USB-export work. And the licensing is comparatively clean: speaking a protocol, like reading a file format, isn't copying anyone's code.

Of everything we've scoped, this is one of the most distinctive — it fixes a real, specific, long-standing annoyance that the incumbent literally cannot fix in its own product without re-architecting how its history works. That's the best kind of feature to own.
