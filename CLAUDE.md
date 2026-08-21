# CLAUDE.md

Guidance for working in this repo. Keep entries here to invariants that are
expensive to rediscover — things the code cannot state for itself, or that got
paid for in someone's real library.

## The rekordbox write-path contract

`exportToRekordboxDb` in `src/main/integrations/rekordbox/db-reader.ts` is the
ONLY code that writes to a user's `master.db`. Everything else Offcut does with
rekordbox is read-only. That file is someone's entire collection, in an
application that keeps it open and caches rows in memory, and the write is not
reversible.

Each field's behaviour is a decision, not an accident:

| target | behaviour |
| --- | --- |
| `FolderPath`, `FileNameL` | always written — this is the relink, it must land |
| `Title`, `BPM`, `Rating`, `Commnt` | fill a blank, never replace a value |
| `djmdCue` | insert only for a track with NO cues; never delete a cue |
| `djmdSongPlaylist` | additive insert only, behind the opt-in switch |
| orphan prune (`rb_local_deleted`) | opt-in, same switch, and only on a recorded pairing whose replacement is already in every affected playlist |

**Do not add an unconditional write to this path.** Every guard above replaced
one, and each replacement followed a measured loss:

- Unconditional `BPM` let a bad analysis overwrite a correct reading a user
  relied on — one measured case read 136.00 as 90.90.
- Unconditional cue writes turned 1,044 hand-placed cues into 37,746 generated
  ones with zero originals surviving. There is deliberately no `DELETE` in the
  cue path at all.
- Unconditional `Rating`/`Commnt`/`Title` reverted edits made in rekordbox on
  the next sync, and wrote `0` and `''` over values for tracks Offcut carried
  nothing for.

Filling a blank is useful. Replacing something the user typed, in either
application, is not ours to do. When a guard declines to write, COUNT IT and
report it — see `cuesSkipped`, `ratingsKept`, `commentsKept`, `titlesKept`. A
silent refusal reads to the user as a broken sync.

### Playlist writeback and the prune are one feature

They share a single opt-in flag (`syncPlaylists`) and must never be separable.
The prune retires a dead row's `djmdSongPlaylist` entries; that is only safe once
the surviving copy has been inserted in their place and observed to be there. The
export does exactly that, in order: write the replacements, re-read membership,
then ask `planOrphanPrune` what may go. Enabling the prune alone is precisely the
configuration that makes playlists quietly lose tracks.

### The prune acts on recorded fact, never inference

`duplicate_replacements` (written by `mergeDuplicateInto`) records which
rekordbox row a resolved duplicate was replaced by. `planOrphanPrune` acts only
on those records.

Do not reintroduce inference here. The previous version deduced deletion from a
missing file plus a same-`Title`-same-`FileSize` twin still on disk. It needed
the file-existence check as a rail against an unmounted drive looking like a
library-wide deletion — and that rail also blocked the only case the feature
existed for, because real duplicates are different encodes with different byte
sizes. Because nothing is inferred now, an unplugged volume produces no pairings
and therefore no deletions, which is a stronger guarantee than the rail was.

### Schema drift is refused, not guessed

`djmdSongPlaylist`'s columns differ across rekordbox versions and we cannot see
the user's schema. `planSongPlaylistInsert` reads the real column list at run
time, drops columns the table lacks, and if the table REQUIRES a column we have
no value for (NOT NULL, no default) the write is skipped and the column named.
Prefer that over inventing a value for one of rekordbox's own sync bookkeeping
columns.

### Import must respect rekordbox's soft delete

Every import query filters `COALESCE(rb_local_deleted, 0) = 0`. Without it, an
import re-creates every row the last export retired and the next sync undoes the
user's dedupe. `COALESCE`, not `= 0`: an older database can hold NULL there.

### Verifying a change to any of this

A real `master.db` is SQLCipher and `openRekordboxDb` owns the handle, so the
export cannot be handed a test database. The substitute is a plain SQLite
database of the right shape:

- `__tests__/songplaylist-write.test.ts` — the real statements against a
  rekordbox-shaped table with foreign keys on, including the field guards.
- `__tests__/dedupe-sync-scenario.test.ts` — the whole workflow composed:
  dedupe in Offcut, then sync. Every unit test below it passed while the
  composition was broken; this is the one that caught it. If you change any part
  of the dedupe-to-rekordbox path, make this test show the end state a DJ would
  actually see.

When you add a guard, verify the test has teeth by reverting the guard and
confirming the test fails. A guard test that passes both ways is worse than none.
