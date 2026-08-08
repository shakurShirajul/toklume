import { defineCommand } from 'citty'
import pc from 'picocolors'
import { openDb } from '../../db/index.js'
import { defaultDbPath } from '../../core/paths.js'
import { printJson } from '../../output/json.js'
import { printLine } from '../../output/table.js'

const HELP = `
Run read-only SQL against your usage database.

The database IS the product: everything the other commands show is just SQL
over these tables. Anything you can express in SQLite, you can ask here.

TABLES

  events        One row per usage-bearing turn, exactly as parsed.
    id, dedupe_key, tool, session_id, model, ts (unix seconds),
    input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
    reasoning_tokens, is_cumulative, is_sidechain, project, source_file

  turn_usage    THE VIEW YOU USUALLY WANT. Same columns as events, but token
                counts are per-turn: sources that log running totals (Codex)
                are differenced here and clamped at zero on session resume.
                Reports read this, never events.

  scan_state    Incremental-scan bookkeeping: one row per log file.
    source_file, size, mtime, byte_offset, scanned_at

NOTES

  * ts is unix seconds. Use DATE(ts,'unixepoch','localtime') for local days.
  * No message text, prompts or code are stored — counts and metadata only.
  * The connection is opened read-only, so writes fail at the driver.

EXAMPLES

  toklume query "SELECT tool, SUM(output_tokens) FROM turn_usage GROUP BY tool"

  toklume query "SELECT project, SUM(input_tokens + output_tokens) AS tokens
                 FROM turn_usage GROUP BY project ORDER BY tokens DESC LIMIT 10"

  toklume query "SELECT DATE(ts,'unixepoch','localtime') AS day,
                 ROUND(1.0 * SUM(cache_read_tokens) /
                   NULLIF(SUM(cache_read_tokens + input_tokens),0), 3) AS cache_hit
                 FROM turn_usage GROUP BY day ORDER BY day DESC LIMIT 14"
`.trim()

export const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description: 'Run read-only SQL against the usage database',
  },
  args: {
    sql: { type: 'positional', required: false, description: 'SQL to execute' },
    db: { type: 'string', description: 'Override the database path' },
    schema: { type: 'boolean', description: 'Print the schema and example queries' },
  },
  run({ args }) {
    if (args.schema || !args.sql) {
      printLine(HELP)
      if (!args.sql && !args.schema) {
        printLine()
        printLine(pc.dim(`Database: ${(args.db as string | undefined) ?? defaultDbPath()}`))
      }
      return
    }

    // readonly: true makes any mutating statement fail at the driver level.
    const db = openDb({ dbPath: args.db as string | undefined, readonly: true })
    try {
      const statement = db.prepare(args.sql as string)

      // `reader` is false for statements that return no rows (INSERT/UPDATE/…);
      // those are rejected by the read-only connection anyway, but running them
      // through .run() gives a clearer message than a driver-level error.
      if (!statement.reader) {
        statement.run()
        printJson([])
        return
      }

      printJson(statement.all())
    } finally {
      db.close()
    }
  },
})
