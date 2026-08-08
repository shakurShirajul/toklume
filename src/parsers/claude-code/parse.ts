import type { NormalizedEvent } from '../types.js'
import { asCount, asRecord, asString, isRecord, parseTimestamp } from '../shared.js'
import { claudeDedupeKey } from './dedupe.js'

/** Outcome of parsing a single line. */
export type LineOutcome =
  | { kind: 'event'; event: NormalizedEvent }
  | { kind: 'ignored' } // valid JSON, but not a usage-bearing entry
  | { kind: 'malformed' } // not JSON at all, or truncated

export interface ClaudeParseOptions {
  sourceFile: string
  /** Session id fallback when the entry carries none (usually the filename stem). */
  fallbackSessionId: string
  /** Project path decoded from the containing directory. */
  project?: string | undefined
  /** Timestamp fallback (unix seconds) when the entry carries none. */
  fallbackTs?: number | undefined
}

/**
 * Convert one JSONL line into a NormalizedEvent.
 *
 * Never throws. Entry shapes vary across Claude Code versions, so every field
 * is read defensively. Only counts and identifiers are read — message content
 * is never touched.
 */
export function parseLine(raw: string, options: ClaudeParseOptions): LineOutcome {
  const line = raw.trim()
  if (line.length === 0) return { kind: 'ignored' }

  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return { kind: 'malformed' }
  }

  if (!isRecord(entry)) return { kind: 'malformed' }

  // Only assistant entries carry usage. Anything else is legitimately ignorable.
  if (entry['type'] !== 'assistant') return { kind: 'ignored' }

  const message = asRecord(entry['message'])
  if (!message) return { kind: 'ignored' }

  const usage = asRecord(message['usage'])
  if (!usage) return { kind: 'ignored' }

  const inputTokens = asCount(usage['input_tokens'])
  const outputTokens = asCount(usage['output_tokens'])
  const cacheWriteTokens = asCount(usage['cache_creation_input_tokens'])
  const cacheReadTokens = asCount(usage['cache_read_input_tokens'])

  const model = asString(message['model']) ?? 'unknown'
  const messageId = asString(message['id'])
  const requestId = asString(entry['requestId'])

  const ts = parseTimestamp(entry['timestamp']) ?? options.fallbackTs ?? 0
  const sessionId = asString(entry['sessionId']) ?? options.fallbackSessionId

  // cwd is the most reliable project signal when present; fall back to the
  // directory-name decoding done by the caller.
  const project = asString(entry['cwd']) ?? options.project

  const event: NormalizedEvent = {
    dedupeKey: claudeDedupeKey(messageId, requestId, options.sourceFile, line),
    tool: 'claude_code',
    sessionId,
    model,
    ts,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    // Claude Code reports thinking tokens inside output_tokens; there is no
    // separate reasoning counter to read.
    reasoningTokens: 0,
    isCumulative: false,
    isSidechain: entry['isSidechain'] === true,
    sourceFile: options.sourceFile,
  }
  if (project !== undefined) event.project = project

  return { kind: 'event', event }
}

