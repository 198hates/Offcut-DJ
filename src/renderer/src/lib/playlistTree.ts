/**
 * Build the nested playlist/folder tree the sidebar renders.
 *
 * rekordbox stores playlists flat with a parentId pointer and arbitrary nesting
 * — a folder holding folders holding playlists. The sidebar previously rendered
 * only ONE level (top-level folders, and of their children only the non-folders),
 * so a folder whose contents are themselves folders looked empty. On a real
 * library `LEM` contains `Bristol`, `Drumsheds` and `Daft Punk VS Justice`,
 * all folders, and none of it was visible.
 *
 * Kept as a pure function so the awkward cases — orphans, cycles, ordering —
 * are testable without rendering anything.
 */
import type { Playlist } from '@shared/types'

export interface PlaylistNode {
  playlist: Playlist
  children: PlaylistNode[]
  /** 0 for a top-level entry; used for indentation. */
  depth: number
  /** Playlists at or below this node, excluding folders. */
  descendantPlaylists: number
}

const byOrderThenName = (a: Playlist, b: Playlist): number =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)

/**
 * @param playlists every playlist, in any order
 * @param include   optional filter, e.g. to leave smart lists out of the tree
 */
export function buildPlaylistTree(
  playlists: Playlist[],
  include: (p: Playlist) => boolean = () => true
): PlaylistNode[] {
  const kept = playlists.filter(include)
  const byId = new Map(kept.map((p) => [p.id, p]))

  // A parent that was filtered out or no longer exists would otherwise make its
  // children invisible — treat those as top-level rather than dropping them.
  const childrenOf = new Map<string | null, Playlist[]>()
  for (const p of kept) {
    const parent = p.parentId && byId.has(p.parentId) ? p.parentId : null
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent)!.push(p)
  }

  // A cycle (A parents B parents A) would recurse forever. Nothing should create
  // one, but this renders a user's sidebar and must not hang on bad data.
  const visited = new Set<string>()

  const build = (parentId: string | null, depth: number): PlaylistNode[] =>
    (childrenOf.get(parentId) ?? [])
      .slice()
      .sort(byOrderThenName)
      .flatMap((playlist) => {
        if (visited.has(playlist.id)) return []
        visited.add(playlist.id)
        const children = build(playlist.id, depth + 1)
        const descendantPlaylists =
          (playlist.isFolder ? 0 : 1) +
          children.reduce((n, c) => n + c.descendantPlaylists, 0)
        return [{ playlist, children, depth, descendantPlaylists }]
      })

  return build(null, 0)
}

/** Ids of every folder that has any descendant — the ones worth expanding. */
export function expandableIds(nodes: PlaylistNode[]): string[] {
  const out: string[] = []
  const walk = (ns: PlaylistNode[]): void => {
    for (const n of ns) {
      if (n.children.length > 0) out.push(n.playlist.id)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}
