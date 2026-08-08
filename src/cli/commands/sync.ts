import { defineCommand } from 'citty'
import pc from 'picocolors'
import { openDb } from '../../db/index.js'
import { Writer } from '../../db/queries.js'
import { detectSources } from '../../parsers/registry.js'
import { scanParser } from '../../core/scan.js'
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
    const started = Date.now()
    const db = openDb({ dbPath: args.db as string | undefined })

    try {
      const writer = new Writer(db)
      const results = []

      for (const source of detectSources()) {
        if (source.roots.length === 0) {
          results.push({ tool: source.parser.id, detected: false })
          continue
        }

        if (source.unsupported) {
          results.push({
            tool: source.parser.id,
            detected: true,
            skipped: true,
            reason: source.unsupported,
          })
          continue
        }

        const summary = scanParser(source.parser, writer, source.files)
        results.push({
          tool: source.parser.id,
          detected: true,
          skipped: false,
          filesScanned: summary.filesScanned,
          filesSkipped: summary.filesSkipped,
          newEvents: summary.inserted,
          duplicatesIgnored: summary.duplicates,
          malformedLines: summary.malformed,
          failures: summary.failures,
        })
      }

      const elapsedMs = Date.now() - started

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
