# Offcut Mobile

Expo / React Native companion for the Offcut desktop app. Talks to the desktop
over the LAN phone-sync API. Contract: **`/MOBILE_COMPANION_PLAN.md`** (repo root).

This is an **isolated project** — its own `package.json`/lockfile, not part of
the Electron root install. The wire types are copied into `src/sync-types.ts`
(we don't import the desktop's `src/shared/types.ts` across the Metro boundary).

## Run it

```bash
cd apps/mobile
npm install
# reconcile native module versions to the installed Expo SDK:
npx expo install expo-camera expo-secure-store expo-status-bar
npx expo start          # then press i (iOS sim), a (Android), or scan with Expo Go
```

> The pinned versions in `package.json` target Expo SDK 52. If `npm install`
> warns about mismatches, run `npx expo install --fix` to align them.

## Pair with the desktop

1. Desktop: **Settings → Phone Sync** → enable → a QR appears.
2. Phone (same Wi-Fi): **Scan pairing QR**, or paste the `offcut://pair/…` URI
   (or `host:port token`) into the manual field.
3. The app stores `{host, port, token}` in the OS keychain (expo-secure-store)
   and confirms reachability via `/health`.

If the desktop later does **Unpair all**, the token rotates and the app gets
401 on its next sync → re-pair.

## Status — slices (see plan §4)

- [x] **1. Pairing + connection** — scan/paste, persist, `/health`, connected state.
- [x] **2. Read-only mirror** — `/sync/pull` into memory, browse tracks + playlists,
  waveform from `/media/peaks` (plain-view bars), audition the AAC proxy via
  `expo-audio` (token in `?token=`; desktop `/media` accepts it). Offline disk
  cache is slice 5.
- [x] **3. Two-way prep** — edit rating/energy/mood/tags/comment/colour + hot cues
  on the track screen, pushed via `POST /sync/push` (last-writer-wins by
  `updatedAt`). Hot cues hook the audition player: "set at playhead" captures the
  current time, tapping a cue seeks to it. The phone never sends beatgrids (the
  lean mirror omits them), so grids are preserved desktop-side.
- [x] **4. Playlists** — create (phone mints a v4 id), rename, recolour, reorder
  (up/down) and remove tracks, delete (confirm), and "Add to playlist" from a
  track. Optimistic local update → `POST /sync/push` (one patch per change),
  rolled back on failure or LWW rejection. Smart playlists / folders are
  read-only.
- [x] **5. Offline** — the library snapshot, peaks, and (opt-in) audio are cached
  to app storage via `expo-file-system`, so the app opens and browses offline.
  Prep + playlist edits made offline queue to disk and flush automatically on
  reconnect (a header chip shows online/offline + queued count, tap to sync now).
  "Save for offline" on a track downloads its proxy so audition works with no LAN.
  Known limit: after a cold start while still offline, queued edits are safe on
  disk but the list shows the last-synced values until the queue flushes.

## Layout

- `src/sync-types.ts` — wire types (mirror of the desktop's over-the-wire subset).
- `src/pairing.ts` — QR/URI parsing + keychain persistence of the connection.
- `src/syncClient.ts` — `SyncClient`: `health` / `pull` / `push` / `peaks` / `proxyRequest`.
- `App.tsx` — slice 1 screen.
