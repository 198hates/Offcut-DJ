import { describe, it, expect } from 'vitest'
import {
  planPlaylistWriteback,
  planSongPlaylistInsert,
  type PlaylistEntry,
  type ColumnInfo
} from '../playlist-writeback'

const entry = (playlistId: string, contentId: string, trackNo = 1): PlaylistEntry => ({
  playlistId,
  contentId,
  trackNo
})

describe('planPlaylistWriteback', () => {
  it('inserts nothing when rekordbox already matches Offcut', () => {
    const wanted = [entry('p1', 'c1'), entry('p1', 'c2')]
    expect(planPlaylistWriteback(wanted, wanted)).toEqual([])
  })

  it('inserts the kept copy where a resolved duplicate used to sit', () => {
    // Offcut moved p1's entry from the removed copy (c-old) onto the keeper.
    // rekordbox still only knows about c-old.
    const wanted = [entry('p1', 'c-keep', 7)]
    const existing = [entry('p1', 'c-old', 7)]
    expect(planPlaylistWriteback(wanted, existing)).toEqual([entry('p1', 'c-keep', 7)])
  })

  it('never removes an entry rekordbox has that Offcut does not', () => {
    // A playlist edited in rekordbox since the last import must survive.
    const result = planPlaylistWriteback([], [entry('p1', 'added-in-rekordbox')])
    expect(result).toEqual([])
  })

  it('keeps the track position Offcut recorded', () => {
    const [only] = planPlaylistWriteback([entry('p1', 'c1', 42)], [])
    expect(only.trackNo).toBe(42)
  })

  it('treats the same track in two playlists as two separate entries', () => {
    const wanted = [entry('p1', 'c1'), entry('p2', 'c1')]
    expect(planPlaylistWriteback(wanted, [entry('p1', 'c1')])).toEqual([entry('p2', 'c1')])
  })

  it('collapses a repeated pair so one insert cannot violate the primary key', () => {
    const wanted = [entry('p1', 'c1', 1), entry('p1', 'c1', 2)]
    expect(planPlaylistWriteback(wanted, [])).toEqual([entry('p1', 'c1', 1)])
  })

  it('is idempotent — running it against its own output adds nothing', () => {
    const wanted = [entry('p1', 'c1'), entry('p2', 'c2')]
    const first = planPlaylistWriteback(wanted, [])
    expect(planPlaylistWriteback(wanted, first)).toEqual([])
  })
})

const col = (name: string, notnull = 0, dflt: unknown = null): ColumnInfo => ({
  name,
  notnull,
  dflt_value: dflt
})

/** The shape we expect on a real rekordbox 6/7 database. */
const REKORDBOX_LIKE: ColumnInfo[] = [
  col('ID', 1),
  col('PlaylistID'),
  col('ContentID'),
  col('TrackNo'),
  col('UUID'),
  col('rb_data_status', 1, 0),
  col('rb_local_data_status', 1, 0),
  col('rb_local_deleted', 1, 0),
  col('rb_local_synced', 1, 0),
  col('usn'),
  col('rb_local_usn'),
  col('created_at', 1),
  col('updated_at', 1)
]

const PROVIDED = ['ID', 'PlaylistID', 'ContentID', 'TrackNo', 'UUID', 'created_at', 'updated_at']

describe('planSongPlaylistInsert', () => {
  it('writes our columns and leaves rekordbox bookkeeping to its defaults', () => {
    const plan = planSongPlaylistInsert(REKORDBOX_LIKE, PROVIDED)
    expect(plan.columns).toEqual(PROVIDED)
    expect(plan.blockedBy).toEqual([])
  })

  it('drops a column the table does not have, rather than failing', () => {
    // Schema drift between rekordbox versions must not break the insert.
    const noUuid = REKORDBOX_LIKE.filter((c) => c.name !== 'UUID')
    const plan = planSongPlaylistInsert(noUuid, PROVIDED)
    expect(plan.columns).not.toContain('UUID')
    expect(plan.blockedBy).toEqual([])
  })

  it('blocks on a required column we have no value for', () => {
    // The djmdCue lesson: a NOT NULL column with no default fails every insert.
    // Better to skip playlists loudly than to invent a value for it.
    const withMystery = [...REKORDBOX_LIKE, col('SomeNewRequiredColumn', 1)]
    expect(planSongPlaylistInsert(withMystery, PROVIDED).blockedBy).toEqual(['SomeNewRequiredColumn'])
  })

  it('does not block on a required column that has a default', () => {
    const withDefault = [...REKORDBOX_LIKE, col('Flags', 1, 0)]
    expect(planSongPlaylistInsert(withDefault, PROVIDED).blockedBy).toEqual([])
  })

  it('does not block on a nullable column we skip', () => {
    expect(planSongPlaylistInsert(REKORDBOX_LIKE, PROVIDED).columns).not.toContain('usn')
  })

  it('preserves the order the values were declared in', () => {
    const plan = planSongPlaylistInsert(REKORDBOX_LIKE, ['ContentID', 'ID', 'PlaylistID'])
    expect(plan.columns).toEqual(['ContentID', 'ID', 'PlaylistID'])
  })
})
