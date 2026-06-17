// Test-only shim: backs the (small) better-sqlite3 API surface our code uses
// with Node's built-in synchronous `node:sqlite`. Aliased to 'better-sqlite3'
// in vitest.config.ts ONLY.
//
// Why: the real better-sqlite3 native addon is rebuilt for Electron's ABI by
// `electron-builder install-app-deps` (postinstall), so it can't load under the
// vitest Node runtime (different NODE_MODULE_VERSION). node:sqlite is part of
// Node itself, so DB unit tests run on any Node ≥ 22.5 without a native build —
// and the app's Electron build is left completely alone.
//
// SQLite semantics are identical (same engine); only the JS binding differs, so
// the only work here is mapping the method names/shapes the code relies on.

import { DatabaseSync } from 'node:sqlite'

class Statement {
  constructor(private readonly stmt: ReturnType<DatabaseSync['prepare']>) {}

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    // node:sqlite may return bigint for changes/rowid; better-sqlite3 returns
    // numbers by default, and our tests/code expect numbers.
    const r = this.stmt.run(...(args as never[]))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  get(...args: unknown[]): unknown {
    return this.stmt.get(...(args as never[]))
  }

  all(...args: unknown[]): unknown[] {
    return this.stmt.all(...(args as never[])) as unknown[]
  }
}

class Database {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql))
  }

  exec(sql: string): this {
    this.db.exec(sql)
    return this
  }

  // better-sqlite3 `.pragma()`: a "name = value" form sets, a bare name reads.
  pragma(source: string): unknown {
    if (source.includes('=')) {
      this.db.exec(`PRAGMA ${source}`)
      return undefined
    }
    return this.db.prepare(`PRAGMA ${source}`).all()
  }

  // better-sqlite3 `.transaction(fn)` returns a function that runs fn inside a
  // transaction, forwarding its arguments and return value.
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.db.exec('BEGIN')
      try {
        const result = fn(...args)
        this.db.exec('COMMIT')
        return result
      } catch (e) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* ignore rollback failure — original error is what matters */
        }
        throw e
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

export default Database
