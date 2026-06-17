// Playlist-mutation helpers for slice 4 (create / reorder / rename / delete).
//
// The desktop applies a PlaylistPatch with last-writer-wins and replaces
// membership wholesale from `trackIds`, so every membership edit sends the full
// ordered id list. The phone mints the id for new playlists (a v4 uuid); the
// desktop inserts under that id.

import type { Playlist } from './sync-types'

/** RFC-4122 v4 uuid. Math.random is fine for a client-minted local id. */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** A blank, phone-created playlist matching the wire shape. */
export function newLocalPlaylist(name: string): Playlist {
  return {
    id: uuid(),
    name: name.trim() || 'New Playlist',
    color: '#8A8474',
    isFolder: false,
    isSmart: false,
    rules: [],
    parentId: null,
    sortOrder: 0,
    trackIds: [],
    sourceIds: {}
  }
}

/** Move the item at `from` to `to`, returning a new array (no-op if out of range). */
export function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length || from < 0 || from >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Append an id if absent (membership is a set, order preserved). */
export function withTrack(trackIds: string[], id: string): string[] {
  return trackIds.includes(id) ? trackIds : [...trackIds, id]
}

/** A playlist the phone is allowed to edit — not a smart playlist or folder. */
export function isEditable(p: Playlist): boolean {
  return !p.isSmart && !p.isFolder
}
