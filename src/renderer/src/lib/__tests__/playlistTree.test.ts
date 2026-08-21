import { describe, it, expect } from 'vitest'
import { buildPlaylistTree, expandableIds } from '../playlistTree'
import type { Playlist } from '@shared/types'

const pl = (id: string, name: string, over: Partial<Playlist> = {}): Playlist =>
  ({
    id, name, isFolder: false, isSmart: false, isAutoGroup: false,
    rules: [], parentId: null, sortOrder: 0, trackIds: [], sourceIds: {},
    color: '', createdAt: '', ...over
  }) as Playlist

describe('buildPlaylistTree', () => {
  it('nests a playlist under its folder', () => {
    const tree = buildPlaylistTree([
      pl('f', 'Folder', { isFolder: true }),
      pl('a', 'Track list', { parentId: 'f' })
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].playlist.id).toBe('f')
    expect(tree[0].children.map((c) => c.playlist.id)).toEqual(['a'])
  })

  it('nests folders inside folders — the case the old sidebar could not show', () => {
    // Mirrors real rekordbox data: LEM contains Bristol, which contains a playlist.
    const tree = buildPlaylistTree([
      pl('lem', 'LEM', { isFolder: true }),
      pl('bristol', 'Bristol', { isFolder: true, parentId: 'lem' }),
      pl('set', 'Bristol Set', { parentId: 'bristol' })
    ])
    expect(tree[0].playlist.name).toBe('LEM')
    expect(tree[0].children[0].playlist.name).toBe('Bristol')
    expect(tree[0].children[0].children[0].playlist.name).toBe('Bristol Set')
  })

  it('records depth for indentation', () => {
    const tree = buildPlaylistTree([
      pl('a', 'A', { isFolder: true }),
      pl('b', 'B', { isFolder: true, parentId: 'a' }),
      pl('c', 'C', { parentId: 'b' })
    ])
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[0].children[0].children[0].depth).toBe(2)
  })

  it('counts playlists beneath a folder, not folders themselves', () => {
    const tree = buildPlaylistTree([
      pl('f', 'F', { isFolder: true }),
      pl('sub', 'Sub', { isFolder: true, parentId: 'f' }),
      pl('p1', 'One', { parentId: 'sub' }),
      pl('p2', 'Two', { parentId: 'f' })
    ])
    expect(tree[0].descendantPlaylists).toBe(2) // p1 + p2, not 'sub'
  })

  it('promotes an orphan to top level rather than hiding it', () => {
    // A parentId pointing at something that no longer exists must not make the
    // playlist invisible — that is data loss from the user's point of view.
    const tree = buildPlaylistTree([pl('x', 'Orphan', { parentId: 'gone' })])
    expect(tree).toHaveLength(1)
    expect(tree[0].playlist.id).toBe('x')
    expect(tree[0].depth).toBe(0)
  })

  it('promotes children of a filtered-out parent', () => {
    const all = [pl('f', 'Smart folder', { isFolder: true, isSmart: true }), pl('c', 'Child', { parentId: 'f' })]
    const tree = buildPlaylistTree(all, (p) => !p.isSmart)
    expect(tree.map((n) => n.playlist.id)).toEqual(['c'])
  })

  it('does not hang on a parent cycle', () => {
    const tree = buildPlaylistTree([
      pl('a', 'A', { isFolder: true, parentId: 'b' }),
      pl('b', 'B', { isFolder: true, parentId: 'a' })
    ])
    // Neither is reachable from a real root, so both resolve to nothing rather
    // than recursing forever. The guarantee under test is that it terminates.
    expect(Array.isArray(tree)).toBe(true)
  })

  it('orders by sortOrder, then name', () => {
    const tree = buildPlaylistTree([
      pl('c', 'Charlie', { sortOrder: 2 }),
      pl('a', 'Alpha', { sortOrder: 1 }),
      pl('b', 'Bravo', { sortOrder: 1 })
    ])
    expect(tree.map((n) => n.playlist.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('applies the filter', () => {
    const tree = buildPlaylistTree(
      [pl('a', 'Keep'), pl('b', 'Drop', { isAutoGroup: true })],
      (p) => !p.isAutoGroup
    )
    expect(tree.map((n) => n.playlist.name)).toEqual(['Keep'])
  })
})

describe('expandableIds', () => {
  it('lists only nodes that have children', () => {
    const tree = buildPlaylistTree([
      pl('f', 'F', { isFolder: true }),
      pl('sub', 'Sub', { isFolder: true, parentId: 'f' }),
      pl('p', 'P', { parentId: 'sub' }),
      pl('lonely', 'Lonely', { isFolder: true })
    ])
    expect(expandableIds(tree).sort()).toEqual(['f', 'sub'])
  })
})
