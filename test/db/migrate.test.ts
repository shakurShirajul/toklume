import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, migrate, currentVersion } from '../../src/db/index.js'
import { MIGRATIONS } from '../../src/db/migrations.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toklume-migrate-'))
  dbPath = join(dir, 'usage.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('creates the schema and records the version on a fresh database', () => {
    const db = openDb({ dbPath })

    expect(existsSync(dbPath)).toBe(true)
    expect(currentVersion(db)).toBe(MIGRATIONS.length)

    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('events')
    expect(tables).toContain('scan_state')
    expect(tables).toContain('schema_version')

    const views = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'view'")
      .all()
      .map((r) => r.name)
    expect(views).toContain('turn_usage')

    db.close()
  })

  it('enables WAL journal mode', () => {
    const db = openDb({ dbPath })
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    db.close()
  })

  it('is a no-op when reopening an already-migrated database', () => {
    const first = openDb({ dbPath })
    const versionAfterFirst = currentVersion(first)
    const rows = first
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_version')
      .get()!.n
    first.close()

    const second = openDb({ dbPath })
    expect(currentVersion(second)).toBe(versionAfterFirst)
    expect(
      second.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_version').get()!.n,
    ).toBe(rows)
    second.close()
  })

  it('rolls back and does not advance the version when a migration fails mid-file', () => {
    const db = new Database(dbPath)

    const broken = [
      { version: 1, name: 'good', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' },
      {
        version: 2,
        name: 'bad',
        sql: `CREATE TABLE beta (id INTEGER PRIMARY KEY);
              CREATE TABLE beta (id INTEGER PRIMARY KEY);`, // second statement fails
      },
    ]

    expect(() => migrate(db, broken)).toThrow(/Migration 2/)

    // Migration 1 committed; migration 2 rolled back entirely.
    expect(currentVersion(db)).toBe(1)
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('alpha')
    expect(tables).not.toContain('beta')

    db.close()
  })

  it('applies only pending migrations on a partially migrated database', () => {
    const db = new Database(dbPath)
    const list = [
      { version: 1, name: 'one', sql: 'CREATE TABLE one (id INTEGER PRIMARY KEY);' },
      { version: 2, name: 'two', sql: 'CREATE TABLE two (id INTEGER PRIMARY KEY);' },
    ]

    migrate(db, list.slice(0, 1))
    expect(currentVersion(db)).toBe(1)

    migrate(db, list)
    expect(currentVersion(db)).toBe(2)

    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
    expect(tables).toContain('two')

    db.close()
  })
})
