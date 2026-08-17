import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../schema'
import { compactSyncLog } from '../sync-log-compact'
import { getChangesSince, getSyncCursor } from '../sync'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  db.exec('DELETE FROM sync_log') // ignore anything the schema itself journalled
  return db
}

const log = (db: Database.Database, entity: string, id: string, op: string): void => {
  db.prepare('INSERT INTO sync_log (entity, entity_id, op) VALUES (?,?,?)').run(entity, id, op)
}

/** n redundant writes for one entity, as a library-wide import would produce. */
function churn(db: Database.Database, entities: number, writesEach: number): void {
  for (let w = 0; w < writesEach; w++) {
    for (let e = 0; e < entities; e++) log(db, 'track', `t${e}`, 'upsert')
  }
}

let db: Database.Database
beforeEach(() => { db = freshDb() })

describe('compactSyncLog', () => {
  it('collapses to one row per entity', () => {
    churn(db, 400, 5) // 2000 rows, 400 entities

    const res = compactSyncLog(db)

    expect(res.before).toBe(2000)
    expect(res.after).toBe(400)
    expect(res.removed).toBe(1600)
  })

  it('leaves the sync cursor unchanged', () => {
    churn(db, 400, 5)
    const before = getSyncCursor(db)

    compactSyncLog(db)

    expect(getSyncCursor(db)).toBe(before)
  })

  it('reports identical changes to a client at any cursor', () => {
    churn(db, 300, 4)
    log(db, 'playlist', 'p1', 'upsert')
    log(db, 'track', 't7', 'delete') // latest op for t7 must win

    const cursors = [0, 1, 500, 900, getSyncCursor(db) - 1]
    const before = cursors.map((c) => JSON.stringify(getChangesSince(db, c)))

    compactSyncLog(db)

    const after = cursors.map((c) => JSON.stringify(getChangesSince(db, c)))
    expect(after).toEqual(before)
  })

  it('keeps the newest op for an entity, not the oldest', () => {
    churn(db, 200, 6)
    log(db, 'track', 't1', 'delete')

    compactSyncLog(db)

    const rows = getChangesSince(db, 0).filter((c) => c.entityId === 't1')
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('delete')
  })

  it('does nothing when there is little to reclaim', () => {
    churn(db, 50, 2) // only 50 redundant rows

    const res = compactSyncLog(db)

    expect(res.removed).toBe(0)
    expect(res.after).toBe(100)
  })

  it('is idempotent', () => {
    churn(db, 400, 5)
    compactSyncLog(db)

    const second = compactSyncLog(db)

    expect(second.removed).toBe(0)
    expect(second.after).toBe(400)
  })
})
