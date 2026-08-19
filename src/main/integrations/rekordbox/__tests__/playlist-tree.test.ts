import { describe, it, expect } from 'vitest'
import { resolvePlaylistTree, type RbPlaylistRow } from '../playlist-tree'

let n = 0
const newId = (): string => `local-${++n}`
const noExisting = (): string | null => null

const row = (ID: string, Name: string, ParentID: unknown, Attribute = 0, Seq = 0): RbPlaylistRow =>
  ({ ID, Name, ParentID, Attribute, Seq })

describe('resolvePlaylistTree', () => {
  it('links a child to its parent when the parent is read FIRST', () => {
    n = 0
    const out = resolvePlaylistTree(
      [row('10', 'Folder', 'root', 1, 0), row('20', 'Child', '10', 0, 1)],
      noExisting, newId
    )
    const folder = out.find((p) => p.rbId === '10')!
    const child = out.find((p) => p.rbId === '20')!
    expect(child.parentInternalId).toBe(folder.internalId)
  })

  it('links a child to its parent when the child is read FIRST', () => {
    // The actual bug: `ORDER BY Seq` is display order, so this happens constantly.
    // The old one-pass resolve produced null here and the playlist lost its nesting.
    n = 0
    const out = resolvePlaylistTree(
      [row('20', 'Child', '10', 0, 0), row('10', 'Folder', 'root', 1, 1)],
      noExisting, newId
    )
    const folder = out.find((p) => p.rbId === '10')!
    const child = out.find((p) => p.rbId === '20')!
    expect(child.parentInternalId).toBe(folder.internalId)
    expect(child.parentInternalId).not.toBeNull()
  })

  it('handles a deep chain given in fully reversed order', () => {
    n = 0
    const out = resolvePlaylistTree(
      [
        row('40', 'Great-grandchild', '30'),
        row('30', 'Grandchild', '20'),
        row('20', 'Child', '10'),
        row('10', 'Root folder', 'root', 1)
      ],
      noExisting, newId
    )
    const by = Object.fromEntries(out.map((p) => [p.rbId, p]))
    expect(by['40'].parentInternalId).toBe(by['30'].internalId)
    expect(by['30'].parentInternalId).toBe(by['20'].internalId)
    expect(by['20'].parentInternalId).toBe(by['10'].internalId)
    expect(by['10'].parentInternalId).toBeNull()
  })

  it("treats rekordbox's root sentinels as top level", () => {
    n = 0
    const out = resolvePlaylistTree(
      [row('1', 'A', 'root'), row('2', 'B', null), row('3', 'C', '')],
      noExisting, newId
    )
    expect(out.map((p) => p.parentInternalId)).toEqual([null, null, null])
  })

  it("does NOT treat a parent id of '0' as root — it is a real playlist id", () => {
    n = 0
    const out = resolvePlaylistTree(
      [row('0', 'Folder zero', 'root', 1), row('5', 'Child', '0')],
      noExisting, newId
    )
    const folder = out.find((p) => p.rbId === '0')!
    expect(out.find((p) => p.rbId === '5')!.parentInternalId).toBe(folder.internalId)
  })

  it('flags folders from Attribute', () => {
    n = 0
    const out = resolvePlaylistTree(
      [row('1', 'Folder', 'root', 1), row('2', 'Playlist', 'root', 0)],
      noExisting, newId
    )
    expect(out[0].isFolder).toBe(true)
    expect(out[1].isFolder).toBe(false)
  })

  it('reuses an existing local id so a re-import updates rather than duplicates', () => {
    n = 0
    const out = resolvePlaylistTree(
      [row('10', 'Folder', 'root', 1), row('20', 'Child', '10')],
      (rbId) => (rbId === '10' ? 'already-here' : null),
      newId
    )
    expect(out.find((p) => p.rbId === '10')!.internalId).toBe('already-here')
    // ...and the child still links to it
    expect(out.find((p) => p.rbId === '20')!.parentInternalId).toBe('already-here')
  })

  it('drops a dangling parent to top level rather than inventing a reference', () => {
    n = 0
    const out = resolvePlaylistTree([row('20', 'Orphan', '999')], noExisting, newId)
    expect(out[0].parentInternalId).toBeNull()
  })

  it('keeps every playlist — nothing is lost by resolving', () => {
    n = 0
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(String(i), `P${i}`, i === 0 ? 'root' : String(i - 1), 0, 50 - i) // reverse Seq
    )
    const out = resolvePlaylistTree(rows, noExisting, newId)
    expect(out).toHaveLength(50)
    expect(out.filter((p) => p.parentInternalId === null)).toHaveLength(1) // only the root
  })
})
