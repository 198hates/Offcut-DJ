/**
 * Deciding which rekordbox rows the export may soft-delete.
 *
 * Offcut's duplicate tool removes a track from the library. The export has no
 * DELETE path of its own — it only ever UPDATEs djmdContent by ID — so those rows
 * survive in rekordbox, pointing at a file that has either been trashed or is now
 * a redundant second copy. On a real library that is thousands of dead entries.
 *
 * This used to be inferred. A row whose file had vanished, and which had a
 * same-Title-same-FileSize twin still readable on disk, was taken to be a
 * duplicate the user had removed. Two problems, and the second one killed it:
 *
 *  - Inferring deletion from a missing file is dangerous. An unplugged external
 *    drive makes every track on it look gone, and soft-deleting someone's whole
 *    library because a USB disk was not mounted is far worse than leaving stale
 *    rows behind. Hence the twin-on-disk requirement, as a rail.
 *  - That rail also blocked the only case it was built for. Real duplicates are
 *    different encodes of one track with DIFFERENT byte sizes, so the twin never
 *    matched. Measured end to end: rekordbox kept 3 playlist entries where Offcut
 *    had 2, two of them pointing at the Trash, and the prune retired nothing.
 *
 * So the guessing is gone. mergeDuplicateInto records the pair when the user
 * resolves a duplicate — this rekordbox row was replaced by that track — and this
 * function acts only on those records. No file-existence check remains, because
 * nothing is being inferred: an unmounted drive produces no pairings and
 * therefore no deletions, which is a stronger guarantee than the old rail gave.
 *
 * Two conditions still have to hold beyond the pairing itself, both about the
 * replacement actually being there:
 *
 *  - The keeper must have a rekordbox row of its own that Offcut still tracks. A
 *    keeper that only exists in Offcut cannot stand in for anything in rekordbox.
 *  - The keeper must already sit in every playlist the removed row is in. The
 *    export writes those entries first and then asks, so the ordering is what
 *    makes the pair safe: place the replacement, verify it landed, only then
 *    retire the original. Otherwise a playlist silently loses a song, which is
 *    the worst thing this feature could do.
 */

/** The subset of djmdContent this decision needs. */
export interface RekordboxRow {
  ID: string
  FolderPath: string | null
  Title: string | null
  FileSize: number | null
}

/**
 * Which playlists each djmdContent row currently has a live entry in, keyed by
 * ContentID. Read AFTER the export's playlist writeback, so a replacement the
 * export just inserted counts as present.
 */
export type PlaylistMembership = Map<string, Set<string>>

/**
 * Removed rekordbox ContentID → the ContentID of the track that replaced it, or
 * null when that keeper has no rekordbox row. Built from duplicate_replacements,
 * resolved through the keeper's CURRENT source_ids so a keeper that gains a
 * rekordbox row later starts working.
 *
 * The null case is carried rather than filtered out on purpose: a missing ENTRY
 * means this row is none of our business, but an entry with no usable keeper is
 * the actionable case — a duplicate the user resolved that cannot be completed in
 * rekordbox — and it has to be counted, not silently dropped.
 */
export type Replacements = Map<string, string | null>

export interface PruneDecision {
  /** Rows the export may soft-delete. */
  prunable: string[]
  /** Recorded pairings that could not be acted on, and why — for reporting. */
  blocked: { removedId: string; reason: 'keeper-not-in-rekordbox' | 'playlist-not-covered' }[]
}

/**
 * Work out which rekordbox rows the export may retire.
 *
 * A row qualifies only when ALL hold:
 *  1. Offcut no longer tracks it. A row Offcut still knows about gets its
 *     FolderPath rewritten instead — the normal relink path, never a deletion.
 *  2. A resolved duplicate recorded it as replaced.
 *  3. Its replacement has a rekordbox row that Offcut still tracks.
 *  4. That replacement is already in every playlist this row appears in.
 */
export function planOrphanPrune(
  rows: readonly RekordboxRow[],
  liveRbIds: ReadonlySet<string>,
  replacements: Replacements,
  membership: PlaylistMembership
): PruneDecision {
  const present = new Set(rows.map((r) => String(r.ID)))
  const prunable: string[] = []
  const blocked: PruneDecision['blocked'] = []

  for (const row of rows) {
    const removedId = String(row.ID)
    // 1 — still ours, so this is a relink, not a removal.
    if (liveRbIds.has(removedId)) continue
    // 2 — no record of a replacement means no licence to delete. Note the
    // has/get split: an absent entry is silence, a null one is a real pairing
    // whose keeper simply is not in rekordbox, and those get reported below.
    if (!replacements.has(removedId)) continue
    const keeperId = replacements.get(removedId) ?? null
    // 3 — the replacement has to exist on both sides to stand in for this row.
    if (keeperId == null || !present.has(keeperId) || !liveRbIds.has(keeperId)) {
      blocked.push({ removedId, reason: 'keeper-not-in-rekordbox' })
      continue
    }
    // 4 — and be in every playlist this row is in, or the playlist loses a song.
    const rowPlaylists = membership.get(removedId)
    if (rowPlaylists && rowPlaylists.size > 0) {
      const keeperPlaylists = membership.get(keeperId)
      const covered = [...rowPlaylists].every((p) => keeperPlaylists?.has(p))
      if (!covered) {
        // Leave the row in place. It shows as a missing file, which is visible
        // and fixable; a vanished playlist entry is neither.
        blocked.push({ removedId, reason: 'playlist-not-covered' })
        continue
      }
    }
    prunable.push(removedId)
  }

  return { prunable, blocked }
}
