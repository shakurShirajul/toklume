import { basename } from 'node:path'
import type { NormalizedEvent, Parser, ParseContext, ParseResult } from '../types.js'
import { codexRoots } from '../../core/paths.js'
import { collectFiles } from '../shared.js'
import { parseLine, codexDedupeKey } from './parse.js'

export const codexParser: Parser = {
  id: 'codex',
  displayName: 'Codex CLI',

  detectRoots(): string[] {
    return codexRoots()
  },

  listFiles(roots: string[]): string[] {
    const files: string[] = []
    // Codex nests sessions under year/month/day directories.
    for (const root of roots) collectFiles(root, files, { extension: '.jsonl', maxDepth: 8 })
    return files.sort()
  },

  parseLines(lines: string[], sourceFile: string, ctx?: ParseContext): ParseResult {
    const stem = basename(sourceFile).replace(/\.jsonl$/, '')

    // Resolve session identity up front. session_meta is written as the first
    // line, but scanning for it first means an event can never be built from a
    // session id that a later line contradicts — which would otherwise leave
    // dedupeKey (derived from the id) disagreeing with the stored sessionId.
    let sessionId = stem
    let project: string | undefined
    for (const line of lines) {
      const outcome = parseLine(line, { sourceFile, fallbackSessionId: stem }, 'unknown')
      if (outcome.kind !== 'session') continue
      sessionId = outcome.sessionId
      if (outcome.project !== undefined) project = outcome.project
      break
    }

    const events: NormalizedEvent[] = []
    let skipped = 0
    let model = 'unknown'
    // Sequence counts usage-bearing lines. Combined with the per-line content
    // hash this keeps keys stable when a file is re-read from offset 0.
    let sequence = 0

    for (const line of lines) {
      const outcome = parseLine(
        line,
        { sourceFile, fallbackSessionId: sessionId, fallbackTs: ctx?.fileMtime },
        model,
      )

      switch (outcome.kind) {
        case 'model':
          model = outcome.model
          break
        case 'malformed':
          skipped += 1
          break
        case 'event': {
          const event: NormalizedEvent = {
            ...outcome.event,
            sessionId,
            model: outcome.event.model === 'unknown' ? model : outcome.event.model,
            dedupeKey: codexDedupeKey(sessionId, sequence, line.trim()),
          }
          if (project !== undefined) event.project = project
          events.push(event)
          sequence += 1
          break
        }
        case 'session':
        case 'ignored':
          break
      }
    }

    return { events, skipped }
  },
}
