import { defineCommand } from 'citty'
import pc from 'picocolors'
import { openDb } from '../../db/index.js'
import { sessionsReport } from '../../reports/sessions.js'
import { COST_CAPTION } from '../../core/pricing.js'
import {
  formatCount,
  formatCost,
  formatTs,
  printLine,
  renderTable,
  shortSessionId,
} from '../../output/table.js'
import { printJson } from '../../output/json.js'
import { basename } from 'node:path'

export const sessionsCommand = defineCommand({
  meta: {
    name: 'sessions',
    description: 'Per-session token rollup, newest first',
  },
  args: {
    db: { type: 'string', description: 'Override the database path' },
    json: { type: 'boolean', description: 'Emit rows as JSON' },
    tool: { type: 'string', description: 'Filter to one tool id' },
    limit: { type: 'string', description: 'Maximum sessions to show (default 25)' },
  },
  run({ args }) {
    const db = openDb({ dbPath: args.db as string | undefined })
    try {
      const limitArg = args.limit as string | undefined
      const limit = limitArg === undefined ? 25 : Number.parseInt(limitArg, 10)
      if (Number.isNaN(limit)) {
        throw new Error(`--limit must be a number, got "${limitArg}"`)
      }

      const report = sessionsReport(db, {
        tool: args.tool as string | undefined,
        limit,
      })

      if (args.json) {
        printJson(report)
        return
      }

      if (report.rows.length === 0) {
        printLine(pc.dim('No sessions recorded. Run `toklume sync` first.'))
        return
      }

      const body = report.rows.map((row) => [
        shortSessionId(row.sessionId),
        row.tool,
        row.project ? basename(row.project) : pc.dim('—'),
        formatTs(row.firstTs),
        formatTs(row.lastTs),
        row.sidechainTurns > 0
          ? `${row.turns} ${pc.dim(`(${row.sidechainTurns} sub)`)}`
          : String(row.turns),
        formatCount(row.inputTokens),
        formatCount(row.outputTokens),
        formatCount(row.cacheWriteTokens),
        formatCount(row.cacheReadTokens),
        formatCost(row.costUsd),
      ])

      printLine(
        renderTable(
          {
            head: [
              'Session',
              'Tool',
              'Project',
              'First',
              'Last',
              'Turns',
              'Input',
              'Output',
              'Cache W',
              'Cache R',
              'Est. cost',
            ],
            rightAlign: [5, 6, 7, 8, 9, 10],
          },
          body,
        ),
      )

      if (report.unknownModels.length > 0) {
        printLine()
        printLine(pc.yellow(`Unpriced models (cost shown as —): ${report.unknownModels.join(', ')}`))
      }

      printLine()
      printLine(pc.dim(COST_CAPTION))
    } finally {
      db.close()
    }
  },
})
