import type { Db } from '../db/index.js'
import { Writer } from '../db/queries.js'
import { detectSources } from '../parsers/registry.js'
import { scanParser } from './scan.js'

export interface ToolSyncResult {
  tool: string
  detected: boolean
  skipped: boolean
  reason?: string
  filesScanned?: number
  filesSkipped?: number
  newEvents?: number
  duplicatesIgnored?: number
  malformedLines?: number
  failures?: { sourceFile: string; error: string }[]
}

export interface SyncResult {
  elapsedMs: number
  tools: ToolSyncResult[]
}

/**
 * Scan every detected agent log source and ingest new events into `db`.
 *
 * Shared by the `sync` CLI command and the dashboard's sync endpoint so both
 * surfaces run the exact same ingest path and can never drift apart.
 */
export function runSync(db: Db): SyncResult {
  const started = Date.now()
  const writer = new Writer(db)
  const tools: ToolSyncResult[] = []

  for (const source of detectSources()) {
    if (source.roots.length === 0) {
      tools.push({ tool: source.parser.id, detected: false, skipped: false })
      continue
    }

    if (source.unsupported) {
      tools.push({
        tool: source.parser.id,
        detected: true,
        skipped: true,
        reason: source.unsupported,
      })
      continue
    }

    const summary = scanParser(source.parser, writer, source.files)
    tools.push({
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

  return { elapsedMs: Date.now() - started, tools }
}
