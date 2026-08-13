import { defineCommand } from 'citty'
import pc from 'picocolors'
import { openDb } from '../../db/index.js'
import { runSync } from '../../core/sync.js'
import { printLine } from '../../output/table.js'
import { printJson } from '../../output/json.js'

export const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Scan agent logs and ingest new token usage into the database',
  },
  args: {
    db: { type: 'string', description: 'Override the database path' },
    json: { type: 'boolean', description: 'Emit the summary as JSON' },
  },
  run({ args }) {
    const db = openDb({ dbPath: args.db as string | undefined })

    try {
      const { elapsedMs, tools: results } = runSync(db)

      if (args.json) {
        printJson({ elapsedMs, tools: results })
        return
      }

      for (const result of results) {
        const parserName = result.tool
        if (!result.detected) {
          printLine(`${pc.dim('○')} ${parserName}: not detected`)
          continue
        }
        if (result.skipped) {
          printLine(`${pc.yellow('!')} ${parserName}: ${result.reason}`)
          continue
        }
        printLine(
          `${pc.green('✓')} ${pc.bold(parserName)}: ` +
            `${result.filesScanned} scanned, ${result.filesSkipped} unchanged, ` +
            `${pc.bold(String(result.newEvents))} new, ` +
            `${result.duplicatesIgnored} duplicate, ${result.malformedLines} malformed`,
        )
        for (const failure of result.failures ?? []) {
          printLine(`  ${pc.red('✗')} ${failure.sourceFile}: ${failure.error}`)
        }
      }

      printLine()
      printLine(pc.dim(`Done in ${(elapsedMs / 1000).toFixed(2)}s`))
    } finally {
      db.close()
    }
  },
})
