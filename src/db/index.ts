import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { defaultDbPath, ensureParentDir, errorMessage } from '../core/paths.js'
import { MIGRATIONS, type Migration } from './migrations.js'

export type { Db }

export interface OpenOptions {
  /** Override the database file location. */
  dbPath?: string | undefined
  /** Open read-only (used by `toklume query`). Skips migrations. */
  readonly?: boolean
}

/**
 * A failure to load better-sqlite3's native binary, rather than a problem with
 * the database file.
 *
 * better-sqlite3 ships prebuilt binaries only up to Node 22, so on newer Node
 * it compiles at install time. When that build is skipped — pnpm 10+ blocks
 * dependency build scripts by default — or when no compiler was available, the
 * binding is missing and every open fails. The raw error is a wall of a dozen
 * attempted paths that says nothing about the fix, so we detect it and explain
 * what to do instead.
 */
function bindingsError(err: unknown): string | null {
  if (!/Could not locate the bindings file/i.test(errorMessage(err))) return null
  return (
    `toklume's SQLite driver (better-sqlite3) has no compiled binary for Node ${process.versions.node}.\n` +
    `\n` +
    `If you installed with pnpm 10+, it blocked the build. Approve it and reinstall:\n` +
    `  pnpm approve-builds -g\n` +
    `  pnpm add -g toklume\n` +
    `\n` +
    `Building also needs a C++ toolchain (Debian/Ubuntu: sudo apt install -y build-essential python3).`
  )
}

/**
 * Open the usage database, applying any pending migrations.
 *
 * Idempotent: safe to call on every command. Read-only opens never migrate,
 * because a read-only handle cannot write and the caller only wants to query.
 */
export function openDb(options: OpenOptions = {}): Db {
  const path = options.dbPath ?? defaultDbPath()

  if (options.readonly) {
    try {
      return new Database(path, { readonly: true, fileMustExist: true })
    } catch (err) {
      const bindings = bindingsError(err)
      if (bindings) throw new Error(bindings)
      throw new Error(
        `Cannot open database ${path} for reading: ${errorMessage(err)}\n` +
          `Run \`toklume sync\` first to create it.`,
      )
    }
  }

  ensureParentDir(path)

  let db: Db
  try {
    db = new Database(path)
  } catch (err) {
    const bindings = bindingsError(err)
    if (bindings) throw new Error(bindings)
    throw new Error(`Cannot open database ${path}: ${errorMessage(err)}`)
  }

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
  } catch (err) {
    db.close()
    throw err
  }

  return db
}

/**
 * Apply pending migrations in ascending order.
 *
 * Each migration runs inside its own explicit transaction together with its
 * schema_version bump, so a failure rolls back both the DDL and the version
 * record — a half-applied migration can never be marked as done.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const current = currentVersion(db)
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Math.floor(Date.now() / 1000),
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${errorMessage(err)}`,
      )
    }
  }
}

/** Highest applied migration version, or 0 on a fresh database. */
export function currentVersion(db: Db): number {
  const row = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_version')
    .get()
  return row?.version ?? 0
}

