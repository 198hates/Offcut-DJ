/**
 * Resolving rekordbox's playlist hierarchy into local ids.
 *
 * djmdPlaylist is a flat table with a ParentID pointer, and the natural read
 * order (`ORDER BY Seq`) is the DISPLAY order within each parent — not a
 * topological one. A child very often appears before its parent.
 *
 * The importer used to resolve a parent from a map it was still filling as it
 * looped, so any playlist read before its parent got `undefined` and silently
 * fell back to null: it imported, but at the top level, with its nesting lost.
 * On a real library that dropped 143 of 286 parent links — about half the
 * hierarchy — while the folders themselves all imported fine, which is why it
 * looked like "folders didn't come across".
 *
 * Resolving in two passes removes the ordering dependency entirely.
 */

/** A row as read from djmdPlaylist. */
export interface RbPlaylistRow {
  ID: unknown
  Name: unknown
  ParentID: unknown
  Attribute: unknown
  Seq?: unknown
}

export interface ResolvedPlaylist {
  rbId: string
  name: string
  isFolder: boolean
  /** Local id — an existing row's id when we've imported this before. */
  internalId: string
  /** Local id of the parent, or null for a top-level entry. */
  parentInternalId: string | null
  sortOrder: number
}

/**
 * rekordbox marks top-level entries with the literal 'root' rather than NULL —
 * confirmed against a real master.db. '0' is deliberately NOT treated as a
 * sentinel: playlist IDs are numeric, so an id of 0 would then be mistaken for
 * "no parent" and its children silently promoted to the top level.
 */
const ROOT_SENTINEL = new Set(['root', ''])

const isRoot = (parentId: unknown): boolean =>
  parentId == null || ROOT_SENTINEL.has(String(parentId).trim().toLowerCase())

/**
 * @param rows      djmdPlaylist rows, in any order
 * @param idFor     existing local id for a rekordbox playlist id, or null if new
 * @param newId     mints an id for a playlist we haven't seen before
 */
export function resolvePlaylistTree(
  rows: RbPlaylistRow[],
  idFor: (rbId: string) => string | null,
  newId: () => string
): ResolvedPlaylist[] {
  // Pass 1 — every playlist gets its local id, so a parent is resolvable
  // regardless of whether it was read before or after its children.
  const localId = new Map<string, string>()
  for (const r of rows) {
    const rbId = String(r.ID)
    if (!localId.has(rbId)) localId.set(rbId, idFor(rbId) ?? newId())
  }

  // Pass 2 — now every lookup can succeed.
  return rows.map((r, i) => {
    const rbId = String(r.ID)
    const parentRbId = isRoot(r.ParentID) ? null : String(r.ParentID)
    return {
      rbId,
      name: String(r.Name ?? ''),
      isFolder: Number(r.Attribute) === 1,
      internalId: localId.get(rbId) as string,
      // A pointer to a playlist that isn't in the result set (filtered out, or
      // dangling in rekordbox) becomes top-level rather than a broken reference.
      parentInternalId: parentRbId ? localId.get(parentRbId) ?? null : null,
      sortOrder: Number(r.Seq ?? i) || i
    }
  })
}
