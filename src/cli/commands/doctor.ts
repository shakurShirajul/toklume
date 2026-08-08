import { defineCommand } from 'citty'
import pc from 'picocolors'
import { statSync, existsSync } from 'node:fs'
import { openDb } from '../../db/index.js'
import { currentVersion } from '../../db/index.js'
import { defaultDbPath } from '../../core/paths.js'
import { detectSources } from '../../parsers/registry.js'
import { distinctModels, eventCount, lastSyncAt, scannedFileCount } from '../../db/queries.js'
import { isUnknownModel, loadPricing } from '../../core/pricing.js'
import { formatTs, printLine } from '../../output/table.js'
import { printJson } from '../../output/json.js'

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Diagnose detection, sync state and pricing coverage',
  },
  args: {
    db: { type: 'string', description: 'Override the database path' },
    json: { type: 'boolean', description: 'Emit the report as JSON' },
  },
  run({ args }) {
    const dbPath = (args.db as string | undefined) ?? defaultDbPath()
    const db = openDb({ dbPath })

    try {
      const pricing = loadPricing()
      const tools = detectSources().map((source) => {
        const models = distinctModels(db, source.parser.id)
        return {
          id: source.parser.id,
          displayName: source.parser.displayName,
          detected: source.roots.length > 0,
          roots: source.roots,
          logFiles: source.files.length,
          scannedFiles: scannedFileCount(db, source.roots),
          unsupported: source.unsupported,
          models,
          unknownModels: models.filter((m) => isUnknownModel(m, pricing)),
        }
      })

      const synced = lastSyncAt(db)
      const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0
      const events = eventCount(db)

      if (args.json) {
        printJson({
          db: { path: dbPath, sizeBytes: dbSize, schemaVersion: currentVersion(db), events },
          lastSyncAt: synced,
          pricingUpdated: pricing.updated,
          tools,
        })
        return
      }

      printLine(pc.bold('Database'))
      printLine(`  path            ${dbPath}`)
      printLine(`  size            ${formatBytes(dbSize)}`)
      printLine(`  schema version  ${currentVersion(db)}`)
      printLine(`  events          ${events.toLocaleString('en-US')}`)
      printLine(`  last sync       ${synced ? formatTs(synced) : pc.dim('never')}`)
      printLine()

      printLine(pc.bold('Sources'))
      for (const tool of tools) {
        if (!tool.detected) {
          printLine(`  ${pc.dim('○')} ${tool.displayName} ${pc.dim('— not detected')}`)
          continue
        }

        const mark = tool.unsupported ? pc.yellow('!') : pc.green('✓')
        printLine(`  ${mark} ${pc.bold(tool.displayName)} (${tool.id})`)
        for (const root of tool.roots) printLine(`      root       ${root}`)

        if (tool.unsupported) {
          printLine(`      ${pc.yellow(tool.unsupported)}`)
          printLine(`      ${pc.dim('Skipped: reporting no numbers beats reporting wrong ones.')}`)
          continue
        }

        printLine(`      log files  ${tool.logFiles} found, ${tool.scannedFiles} scanned`)
        if (tool.models.length > 0) {
          printLine(`      models     ${tool.models.join(', ')}`)
        }
        if (tool.unknownModels.length > 0) {
          printLine(`      ${pc.yellow(`unpriced   ${tool.unknownModels.join(', ')}`)}`)
        }
      }

      printLine()
      printLine(pc.bold('Pricing'))
      printLine(`  bundled table   updated ${pricing.updated}`)
      const allUnknown = [...new Set(tools.flatMap((t) => t.unknownModels))]
      if (allUnknown.length > 0) {
        printLine(
          `  ${pc.yellow(`${allUnknown.length} model(s) have no rates; their cost shows as —`)}`,
        )
      } else {
        printLine(pc.dim('  every model seen has bundled rates'))
      }

      if (synced === null) {
        printLine()
        printLine(pc.dim('Next step: run `toklume sync` to ingest your history.'))
      }
    } finally {
      db.close()
    }
  },
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
