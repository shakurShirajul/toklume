import type { NormalizedEvent } from '../types.js'
import { asCount, asRecord, asString, hash8, isRecord, parseTimestamp } from '../shared.js'

export type LineOutcome =
  | { kind: 'event'; event: Omit<NormalizedEvent, 'dedupeKey'> }
  | { kind: 'model'; model: string } // turn_context carries the model for later lines
  | { kind: 'session'; sessionId: string; project?: string }
  | { kind: 'ignored' }
  | { kind: 'malformed' }

export interface CodexParseOptions {
  sourceFile: string
  fallbackSessionId: string
  fallbackTs?: number | undefined
}

/**
 * Parse one line of a Codex rollout JSONL file.
 *
 * Codex emits several event kinds; three matter here:
 *  - session_meta        -> session id and cwd
 *  - turn_context        -> the model in use for subsequent turns
 *  - event_msg/token_count -> usage, as RUNNING TOTALS for the session
 *
 * token_count also fires with `info: null` (rate-limit-only updates); those
 * carry no usage and are ignored rather than recorded as zero-token turns.
 */
export function parseLine(
  raw: string,
  options: CodexParseOptions,
  currentModel: string,
): LineOutcome {
  const line = raw.trim()
  if (line.length === 0) return { kind: 'ignored' }

  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return { kind: 'malformed' }
  }
  if (!isRecord(entry)) return { kind: 'malformed' }

  const payload = asRecord(entry['payload'])
  const type = asString(entry['type'])

  if (type === 'session_meta' && payload) {
    const sessionId = asString(payload['id'])
    const cwd = asString(payload['cwd'])
    if (sessionId) {
      const out: { kind: 'session'; sessionId: string; project?: string } = {
        kind: 'session',
        sessionId,
      }
      if (cwd !== undefined) out.project = cwd
      return out
    }
    return { kind: 'ignored' }
  }

  if (type === 'turn_context' && payload) {
    const model = asString(payload['model'])
    return model ? { kind: 'model', model } : { kind: 'ignored' }
  }

  if (type !== 'event_msg' || !payload || payload['type'] !== 'token_count') {
    return { kind: 'ignored' }
  }

  const info = asRecord(payload['info'])
  if (!info) return { kind: 'ignored' } // rate-limit-only update

  const totals = asRecord(info['total_token_usage'])
  if (!totals) return { kind: 'ignored' }

  const rawInput = asCount(totals['input_tokens'])
  const cacheRead = asCount(totals['cached_input_tokens'])
  const output = asCount(totals['output_tokens'])
  const reasoning = asCount(totals['reasoning_output_tokens'])

  // `input_tokens` is inclusive of `cached_input_tokens`; split them so cache
  // reads are not double counted against the (more expensive) input rate.
  const input = Math.max(rawInput - cacheRead, 0)

  const ts = parseTimestamp(entry['timestamp']) ?? options.fallbackTs ?? 0

  return {
    kind: 'event',
    event: {
      tool: 'codex',
      sessionId: options.fallbackSessionId,
      model: currentModel,
      ts,
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: 0, // Codex does not report cache writes separately.
      cacheReadTokens: cacheRead,
      reasoningTokens: reasoning,
      // Values are running totals; turn_usage derives clamped per-turn deltas.
      isCumulative: true,
      isSidechain: false,
      sourceFile: options.sourceFile,
    },
  }
}

/**
 * Dedupe key for a Codex usage line.
 *
 * The sequence makes each turn distinct within a session; the content hash
 * makes re-parsing after an offset reset idempotent (the same line at the same
 * sequence produces the same key).
 */
export function codexDedupeKey(sessionId: string, sequence: number, rawLine: string): string {
  return `codex:${sessionId}:${sequence}:${hash8(rawLine)}`
}

