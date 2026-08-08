import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NormalizedEvent, Parser, ParseContext, ParseResult } from '../types.js'
import { openCodeRoots } from '../../core/paths.js'
import {
  asCount,
  asRecord,
  asString,
  collectFiles,
  hash8,
  isRecord,
  parseTimestamp,
} from '../shared.js'

/**
 * OpenCode's storage backend varies by version (JSONL in some, SQLite in
 * others). We detect the format before parsing anything: reporting no numbers
 * is better than reporting wrong ones.
 */
export const openCodeParser: Parser = {
  id: 'opencode',
  displayName: 'OpenCode',

  detectRoots(): string[] {
    return openCodeRoots()
  },

  listFiles(roots: string[]): string[] {
    // Only JSONL sources are supported; if the install is SQLite-backed,
    // unsupportedReason() short-circuits before this matters.
    const files: string[] = []
    for (const root of roots) {
      for (const dir of ['storage', 'session', 'sessions', 'message']) {
        collectFiles(join(root, dir), files, { extension: '.jsonl', maxDepth: 6 })
      }
    }
    return files.sort()
  },

  /**
   * Returns a human-readable reason when this install cannot be parsed.
   * sync and doctor surface the message and skip the source.
   */
  unsupportedReason(roots: string[], files: string[]): string | null {
    if (roots.length === 0) return null

    for (const root of roots) {
      const sqliteFile = findSqlite(root)
      if (sqliteFile) {
        return `OpenCode detected but format not yet supported (found: ${sqliteFile})`
      }
    }

    if (files.length === 0) {
      return `OpenCode detected but format not yet supported (found: ${roots[0]})`
    }
    return null
  },

  parseLines(lines: string[], sourceFile: string, ctx?: ParseContext): ParseResult {
    const events: NormalizedEvent[] = []
    let skipped = 0
    const fallbackSessionId = basename(sourceFile).replace(/\.jsonl$/, '')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      let entry: unknown
      try {
        entry = JSON.parse(trimmed)
      } catch {
        skipped += 1
        continue
      }
      if (!isRecord(entry)) {
        skipped += 1
        continue
      }

      const tokens = asRecord(entry['tokens'])
      if (!tokens) continue

      const cache = asRecord(tokens['cache'])
      const model = asString(entry['modelID']) ?? asString(entry['model']) ?? 'unknown'
      const sessionId = asString(entry['sessionID']) ?? fallbackSessionId
      const ts = readTimestamp(entry) ?? ctx?.fileMtime ?? 0
      const id = asString(entry['id'])

      events.push({
        dedupeKey: id ? `oc:${id}` : `oc:${hash8(`${sourceFile} ${trimmed}`)}`,
        tool: 'opencode',
        sessionId,
        model,
        ts,
        inputTokens: asCount(tokens['input']),
        outputTokens: asCount(tokens['output']),
        cacheWriteTokens: asCount(cache?.['write']),
        cacheReadTokens: asCount(cache?.['read']),
        reasoningTokens: asCount(tokens['reasoning']),
        isCumulative: false,
        isSidechain: false,
        sourceFile,
      })
    }

    return { events, skipped }
  },
}

/** Find a SQLite database directly under an OpenCode root. */
function findSqlite(root: string): string | null {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (/\.(db|sqlite|sqlite3)$/.test(entry.name)) {
      const full = join(root, entry.name)
      if (looksLikeSqlite(full)) return full
    }
  }
  return null
}

/**
 * SQLite files start with the magic string "SQLite format 3\0".
 *
 * Reads only the 16-byte header: an OpenCode store is routinely tens of MB,
 * and this runs on every detection pass.
 */
function looksLikeSqlite(file: string): boolean {
  const header = Buffer.allocUnsafe(16)
  let fd
  try {
    fd = openSync(file, 'r')
    const bytesRead = readSync(fd, header, 0, 16, 0)
    if (bytesRead < 15) return false
    return header.toString('utf8', 0, 15) === 'SQLite format 3'
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Pick the most meaningful timestamp an OpenCode entry offers.
 *
 * The field preference is OpenCode-specific; the coercion is shared.
 */
function readTimestamp(entry: Record<string, unknown>): number | undefined {
  const time = asRecord(entry['time'])
  return parseTimestamp(
    time?.['completed'] ?? time?.['created'] ?? entry['time'] ?? entry['timestamp'],
  )
}
