export type ToolId = 'claude_code' | 'codex' | 'opencode'

/**
 * A single usage-bearing turn, normalized across tools.
 *
 * Deliberately contains NO message content: counts, ids, model names,
 * timestamps and paths only.
 */
export interface NormalizedEvent {
  dedupeKey: string
  tool: ToolId
  sessionId: string
  model: string
  /** Unix seconds. */
  ts: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  /** True when the raw values are running totals for the session. */
  isCumulative: boolean
  /** True for subagent/sidechain turns. */
  isSidechain: boolean
  project?: string
  sourceFile: string
}

export interface ParseResult {
  events: NormalizedEvent[]
  /** Lines that looked like they should have parsed but did not. */
  skipped: number
}

export interface ParseContext {
  /** Fallback timestamp (unix seconds) when a line carries none. */
  fileMtime?: number
}

export interface Parser {
  id: ToolId
  displayName: string
  /** Absolute paths of log roots that exist on this machine (may be several). */
  detectRoots(): string[]
  /** All candidate log files under the given roots. */
  listFiles(roots: string[]): string[]
  /** Parse a chunk of new lines from one file. Must never throw on bad input. */
  parseLines(lines: string[], sourceFile: string, ctx?: ParseContext): ParseResult
  /**
   * Optional pre-flight check. When it returns a message, sync/doctor report it
   * and skip the source rather than guessing at an unknown format.
   *
   * Receives the file list already produced by `listFiles` so implementations
   * never need to re-walk the log tree.
   */
  unsupportedReason?(roots: string[], files: string[]): string | null
}
