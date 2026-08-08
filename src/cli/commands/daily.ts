import { defineCommand } from 'citty'
import pc from 'picocolors'
import { openDb } from '../../db/index.js'
import { dailyReport } from '../../reports/daily.js'
import { COST_CAPTION } from '../../core/pricing.js'
import { formatCount, formatCost, printLine, renderTable } from '../../output/table.js'
import { printJson } from '../../output/json.js'

export const dailyCommand = defineCommand({
  meta: {
    name: 'daily',
    description: 'Token usage per day, per tool',
  },
  args: {
    db: { type: 'string', description: 'Override the database path' },
    json: { type: 'boolean', description: 'Emit rows as JSON' },
    since: { type: 'string', description: 'Start date, inclusive (YYYY-MM-DD, local time)' },
    until: { type: 'string', description: 'End date, inclusive (YYYY-MM-DD, local time)' },
    tool: { type: 'string', description: 'Filter to one tool id' },
  },
  run({ args }) {
    const db = openDb({ dbPath: args.db as string | undefined })
    try {
      const report = dailyReport(db, {
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        tool: args.tool as string | undefined,
      })

      if (args.json) {
        printJson(report)
        return
      }

      if (report.rows.length === 0) {
        printLine(pc.dim('No usage recorded for this range. Run `toklume sync` first.'))
        return
      }

      const body = report.rows.map((row) => [
        row.date,
        row.tool,
        formatCount(row.inputTokens),
        formatCount(row.outputTokens),
        formatCount(row.cacheWriteTokens),
        formatCount(row.cacheReadTokens),
        formatCount(row.reasoningTokens),
        formatCost(row.costUsd),
      ])

      const t = report.totals
      body.push([
        pc.bold('TOTAL'),
        '',
        pc.bold(formatCount(t.inputTokens)),
        pc.bold(formatCount(t.outputTokens)),
        pc.bold(formatCount(t.cacheWriteTokens)),
        pc.bold(formatCount(t.cacheReadTokens)),
        pc.bold(formatCount(t.reasoningTokens)),
        pc.bold(formatCost(t.costUsd)),
      ])

      printLine(
        renderTable(
          {
            head: ['Date', 'Tool', 'Input', 'Output', 'Cache W', 'Cache R', 'Reasoning', 'Est. cost'],
            rightAlign: [2, 3, 4, 5, 6, 7],
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
