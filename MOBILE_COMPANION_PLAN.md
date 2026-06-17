# Mobile Companion — Implementation Handoff

Status as of branch `claude/dj-app-killer-features-3z9wuw`.

The **entire desktop-side sync backend is built, wired into the running app,
and unit-tested** (41 tests across the sync modules). What remains is the
**React Native / Expo client app**, which lives in its own project — it talks to
the desktop over the LAN endpoints documented below.

This document is the contract. A desktop session can implement the app against
it without re-reading the chat that produced it.

---

## 1. What's already done (desktop)

| Piece | Files |
|---|---|
| Change journal (delta sync) | `src/main/library/schema.ts` (sync_log + triggers), `src/main/library/sync.ts` |
| Content-hash identity | `src/main/library/content-hash.ts` |
| Push/merge (last-writer-wins) | `src/main/library/apply-push.ts` |
| LAN HTTP server | `src/main/sync/server.ts` |
| Pairing + bearer auth | `src/main/sync/pairing.ts` |
| Media: peaks + AAC proxies | `src/main/sync/media.ts` |
| IPC + lifecycle wiring | `src/main/ipc/sync.ts`, `src/main/index.ts` |
| Settings UI (toggle, QR, devices) | `src/renderer/src/components/PhoneSyncPanel.tsx` |

It links into the desktop app through the **single shared `getLibraryDb()`** —
the server reads/writes the same `library.db` the desktop uses, and SQLite
triggers journal every write automatically (no existing write path changed).

**Locked product decisions:** LAN-direct transport (no cloud), offline AAC
proxies + precomputed peaks (true offline prep), React Native + Expo client.

---

## 2. The API contract

Server: plain HTTP, binds `0.0.0.0`, default port **47823** (configurable, stored
in `phone-sync.json`). Enabled from desktop **Settings → Phone Sync**.

### Auth
Every `/sync/*` and `/media/*` request needs:
```
Authorization: Bearer <token>
```
Optional identification (populates the desktop's device list):
```
X-Device-Id:   <stable uuid the app generates once>
X-Device-Name: <e.g. "Nathan's iPhone">
```
`/health` is the only unauthenticated route.

### Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | no | `{ ok: true, name, version }` |
| GET | `/sync/pull?cursor=N` | yes | `SyncPull` |
| POST | `/sync/push` | yes | `SyncPushResult` |
| GET | `/media/peaks?track=<id>` | yes | `PeaksData` (JSON) |
| GET | `/media/proxy?track=<id>` | yes | `audio/mp4`, supports `Range` (206) |

### Pairing
Desktop shows a QR encoding:
```
offcut://pair/<base64url>
```
where the decoded payload is:
```json
{ "v": 1, "host": "192.168.1.x", "port": 47823, "token": "…", "name": "Offcut" }
```
The app scans it, stores `{host, port, token}`, and uses them for every request.
"Unpair all" on desktop rotates the token (instantly locking out devices).

### Wire types
All in **`src/shared/types.ts`** — copy/mirror them into the app verbatim:
`SyncPull`, `TrackPatch`, `PlaylistPatch`, `SyncPushPayload`, `SyncPushResult`,
`Track`, `Playlist`, `CuePoint`, `BeatgridMarker`, `Beatgrid`.
`PeaksData` is in `src/main/sync/media.ts`.

```ts
// pull response
interface SyncPull {
  cursor: number            // send this as ?cursor= next time
  tracks: Track[]           // upserts
  playlists: Playlist[]     // upserts
  deletedTrackIds: string[]
  deletedPlaylistIds: string[]
}

// push request
interface SyncPushPayload { tracks?: TrackPatch[]; playlists?: PlaylistPatch[] }

interface TrackPatch {       // only present keys are written (partial patch)
  id: string                 // desktop id (from pull); falls back to contentHash
  contentHash?: string
  updatedAt: string          // ISO-8601 UTC — gates last-writer-wins
  rating?: number; energy?: number | null; mood?: number | null
  comment?: string; color?: string
  tags?: string[]; customTags?: Record<string,string>
  cuePoints?: CuePoint[]; beatgrid?: BeatgridMarker[]; analysedBeatgrid?: Beatgrid | null
}

interface PlaylistPatch {
  id: string                 // unknown id => create
  updatedAt: string
  deleted?: boolean
  name?: string; color?: string
  trackIds?: string[]        // replaces membership, in order
}

interface SyncPushResult {
  appliedTracks: number; skippedTracks: number
  appliedPlaylists: number; skippedPlaylists: number
  cursor: number             // fast-forward your cursor to this after pushing
}

// GET /media/peaks
interface PeaksData {
  v: 1; trackId: string; contentHash: string | null
  buckets: number; durationSec: number
  peaks: number[]; low: number[]; mid: number[]; high: number[]  // 0..255, divide by 255
}
```

---

## 3. Sync loop semantics

**Pull (server → app):**
1. Store a `cursor` per pairing (start at 0).
2. `GET /sync/pull?cursor=<stored>`. `cursor=0` returns a **full snapshot**;
   thereafter only deltas.
3. Upsert `tracks`/`playlists` into the local mirror; drop `deletedTrackIds`/
   `deletedPlaylistIds`; save the returned `cursor`.
4. Poll on app foreground / pull-to-refresh (no push channel needed for v1).

**Push (app → server):**
1. When the user edits, write locally and stamp `updatedAt = new Date().toISOString()`.
2. Batch dirty entities into `SyncPushPayload` and `POST /sync/push`.
3. The server applies **last-writer-wins** per entity: an edit older than the
   desktop's copy is skipped (counted in `skipped*`). Only present fields are
   written. **Tracks can't be created from the app** (no audio file on desktop)
   — unknown track ids are skipped. Playlists **can** be created/renamed/
   reordered/deleted.
4. Fast-forward your cursor to the returned `cursor` to skip your own echo.

**Media:**
- Peaks: render the 4 bands (peaks/low/mid/high, 0..255) — same colour waveform
  the desktop draws.
- Proxy: 128k AAC with `+faststart`; supports HTTP range, so stream/seek freely.
  Cache both on device for offline prep.

---

## 4. Expo app build plan

Recommended stack (chosen for max code reuse with this TS/React codebase):
- **Expo (React Native)** — iOS + Android, one codebase.
- **Local mirror:** `op-sqlite` or **WatermelonDB** (built for this sync shape).
- **Audio:** `react-native-track-player` (background-capable).
- **Waveform:** `@shopify/react-native-skia` (mirrors the desktop GL waveform).
- **QR scan:** `expo-camera` / `expo-barcode-scanner`.
- **Networking:** `fetch` is enough; no mDNS needed (the QR carries the address).

Suggested slices (each shippable/testable on its own):
1. **Pairing + connection** — scan QR, store `{host,port,token}`, hit `/health`,
   show connected state.
2. **Read-only mirror** — full `/sync/pull`, persist locally, browse library +
   playlists. Render peaks from `/media/peaks`. Audition via `/media/proxy`.
   Proves the whole pipe end-to-end.
3. **Two-way prep** — edit rating/energy/mood/tags/comment/colour + hot cues
   against the Skia waveform; queue `TrackPatch`es; `POST /sync/push`; reconcile
   with the returned cursor.
4. **Playlists** — create/reorder/rename/delete; push `PlaylistPatch`es.
5. **Offline** — cache proxies + peaks; queue edits while disconnected and flush
   on reconnect.

---

## 5. Verifying against a running desktop

Enable **Settings → Phone Sync**, then read host/port/token from
`<userData>/phone-sync.json` (or the pairing panel). Then from any LAN machine:

```bash
TOKEN=…   HOST=…   PORT=47823
curl http://$HOST:$PORT/health
curl -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/sync/pull?cursor=0"
curl -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/media/peaks?track=<id>"
curl -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-1024" \
     "http://$HOST:$PORT/media/proxy?track=<id>" -o chunk.m4a
```

---

## 6. Optional desktop follow-ups (not required for MVP)

- mDNS/Bonjour advertise so the app can rediscover the desktop after IP changes
  (today the QR carries the address; re-scan if it moves).
- Per-device token revocation (today "unpair all" rotates the single token).
- A "rebuild proxies/peaks cache" maintenance control.
- WebSocket push channel for live desktop→app updates (today the app polls).
- Conflict surfacing in the UI when a push is skipped by last-writer-wins.

---

## 7. Project layout decision

Put the Expo app in **`apps/mobile/`** in this repo (monorepo). Keep
`src/shared/types.ts` as the **single source of truth** for the desktop, but do
**not** try to import it across the React Native bundler/tsconfig boundary — it
pulls in Electron-only types. Instead create a small
`apps/mobile/src/sync-types.ts` that re-declares only the wire subset
(`SyncPull`, `TrackPatch`, `PlaylistPatch`, `SyncPushPayload`, `SyncPushResult`,
`PeaksData`, and the `Track`/`Playlist`/`CuePoint`/`BeatgridMarker`/`Beatgrid`
shapes used over the wire), with a header comment pointing back here. These
shapes are stable; a copy is lower-risk than restructuring the desktop's many
imports. (Revisit npm/yarn workspaces + a `packages/shared` later if the surface
grows.)

Do not add the app's deps to the root `package.json` — `apps/mobile/` gets its
own `package.json` and lockfile so Expo/Metro tooling stays isolated from
Electron.

---

## 8. Example payloads

Real shapes (fields per `src/shared/types.ts`). Desktop writes `updatedAt` in
SQLite form (`"2026-06-15 19:22:03"`); the app should send ISO-8601
(`"2026-06-15T19:22:03Z"`). The merge parses both, so either is accepted.

**GET `/sync/pull?cursor=0`** →
```json
{
  "cursor": 1487,
  "tracks": [
    {
      "id": "trk_8f3a", "filePath": "/Music/Artist - Title.flac",
      "title": "Title", "artist": "Artist", "album": "Album", "genre": "Tech House",
      "year": 2024, "label": "Drumcode", "bpm": 126, "key": "8A",
      "durationSeconds": 372.5, "rating": 4, "color": "#3CA8A1",
      "energy": 7, "danceability": 0.82, "mood": 0.3,
      "playCount": 5, "lastPlayedAt": "2026-06-10T21:14:00Z",
      "dateAdded": "2026-01-02T12:00:00Z", "updatedAt": "2026-06-15 19:22:03",
      "comment": "peak time", "tags": ["peak", "vocal"],
      "customTags": { "set": "closing" },
      "cuePoints": [
        { "index": 0, "type": "hotcue", "positionMs": 15280, "color": "#FF5C00", "label": "Drop" },
        { "index": 1, "type": "loop", "positionMs": 30560, "endMs": 38080, "color": "#00A1FF", "label": "Outro" }
      ],
      "beatgrid": [{ "positionMs": 280, "bpm": 126, "isDownbeat": true, "confidence": 0.98 }],
      "analysedBeatgrid": {
        "beats": [{ "positionMs": 280, "beatInBar": 0, "confidence": 0.98 }],
        "bars": [{ "positionMs": 280, "bpm": 126, "barIndex": 0 }],
        "downbeats": [280, 2185], "source": "beat-this", "medianBpm": 126,
        "firstBeatMs": 280, "isConstantTempo": true, "computedAt": "2026-05-01T10:00:00Z"
      },
      "editLineage": null, "sourceIds": { "rekordbox": "12345" },
      "fileSize": 41231920, "fileType": "flac", "sampleRate": 44100,
      "bitDepth": 24, "gainDb": -1.5, "phrases": null
    }
  ],
  "playlists": [
    {
      "id": "pl_warmup", "name": "Warmup", "color": "#3CA8A1",
      "isFolder": false, "isSmart": false, "isAutoGroup": false, "rules": [],
      "parentId": null, "sortOrder": 0,
      "trackIds": ["trk_8f3a", "trk_2b11"], "sourceIds": {}
    }
  ],
  "deletedTrackIds": [],
  "deletedPlaylistIds": []
}
```

**POST `/sync/push`** body →
```json
{
  "tracks": [
    { "id": "trk_8f3a", "updatedAt": "2026-06-16T09:00:00Z", "rating": 5, "energy": 8, "tags": ["peak", "tested"] },
    { "id": "phone-local-xyz", "contentHash": "9c1f…", "updatedAt": "2026-06-16T09:01:00Z", "mood": 0.4,
      "cuePoints": [{ "index": 0, "type": "hotcue", "positionMs": 16000, "color": "#FF5C00", "label": "Drop" }] }
  ],
  "playlists": [
    { "id": "pl_new_uuid", "updatedAt": "2026-06-16T09:02:00Z", "name": "Sunday Closers", "trackIds": ["trk_2b11", "trk_8f3a"] }
  ]
}
```
→ response:
```json
{ "appliedTracks": 2, "skippedTracks": 0, "appliedPlaylists": 1, "skippedPlaylists": 0, "cursor": 1492 }
```

**GET `/media/peaks?track=trk_8f3a`** →
```json
{
  "v": 1, "trackId": "trk_8f3a", "contentHash": "9c1f…",
  "buckets": 2000, "durationSec": 372.5,
  "peaks": [0, 14, 33, 120, 255, 240, "…0..255, length=buckets"],
  "low": ["…"], "mid": ["…"], "high": ["…"]
}
```

---

## 9. Error responses

All errors are JSON `{ "error": "<reason>" }` with these statuses:

| Status | When |
|---|---|
| 401 | missing/invalid bearer token on a `/sync/*` or `/media/*` route |
| 404 | unknown route, or `track` not found / no peaks/proxy available |
| 400 | malformed JSON body, or a push body that isn't an object |
| 413 | push body exceeds 64 MB |
| 206 | partial content (successful ranged `/media/proxy` request) |
| 500 | unexpected server error (message in `error`) |

The app should treat a 401 as "re-pair required" (token was rotated on desktop).

