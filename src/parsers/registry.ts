import type { Parser } from './types.js'
import { claudeCodeParser } from './claude-code/index.js'
import { codexParser } from './codex/index.js'
import { openCodeParser } from './opencode/index.js'

/** Ordered parser list. `sync` and `doctor` iterate this. */
export const PARSERS: Parser[] = [claudeCodeParser, codexParser, openCodeParser]

export interface DetectedSource {
  parser: Parser
  roots: string[]
  files: string[]
  /** Non-null when the install exists but its format cannot be parsed. */
  unsupported: string | null
}

/**
 * Detect every source present on this machine.
 *
 * Each log tree is walked exactly once: the file list is handed to
 * `unsupportedReason` rather than recomputed by it.
 */
export function detectSources(): DetectedSource[] {
  return PARSERS.map((parser) => {
    const roots = parser.detectRoots()
    if (roots.length === 0) {
      return { parser, roots, files: [], unsupported: null }
    }

    const files = parser.listFiles(roots)
    const unsupported = parser.unsupportedReason?.(roots, files) ?? null
    return {
      parser,
      roots,
      // An unsupported source is reported and skipped, never parsed.
      files: unsupported === null ? files : [],
      unsupported,
    }
  })
}
