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
- [ ] 2. Read-only mirror — `/sync/pull`, browse library + playlists, peaks, audition via `/media/proxy`.
- [ ] 3. Two-way prep — edit rating/energy/mood/tags/comment/colour + hot cues; `POST /sync/push`.
- [ ] 4. Playlists — create/reorder/rename/delete.
- [ ] 5. Offline — cache proxies + peaks; queue edits and flush on reconnect.

## Layout

- `src/sync-types.ts` — wire types (mirror of the desktop's over-the-wire subset).
- `src/pairing.ts` — QR/URI parsing + keychain persistence of the connection.
- `src/syncClient.ts` — `SyncClient`: `health` / `pull` / `push` / `peaks` / `proxyRequest`.
- `App.tsx` — slice 1 screen.
