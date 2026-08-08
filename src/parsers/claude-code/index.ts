import { readdirSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import type { Parser, ParseContext, ParseResult } from '../types.js'
import { claudeCodeRoots, decodeProjectDir } from '../../core/paths.js'
import { collectFiles } from '../shared.js'
import { parseLine } from './parse.js'

export const claudeCodeParser: Parser = {
  id: 'claude_code',
  displayName: 'Claude Code',

  detectRoots(): string[] {
    return claudeCodeRoots()
  },

  listFiles(roots: string[]): string[] {
    const files: string[] = []
    for (const root of roots) {
      // Layout is <root>/<encoded-project>/<session-id>.jsonl, but subagent
      // transcripts are nested deeper (…/<session-id>/subagents/agent-*.jsonl),
      // so walk the whole tree rather than a single level.
      for (const projectDir of safeReadDirs(root)) {
        collectFiles(join(root, projectDir), files, { extension: '.jsonl', maxDepth: 6 })
      }
    }
    return files.sort()
  },

  parseLines(lines: string[], sourceFile: string, ctx?: ParseContext): ParseResult {
    const events = []
    let skipped = 0

    const fallbackSessionId = basename(sourceFile).replace(/\.jsonl$/, '')
    const project = projectFromPath(sourceFile)

    for (const line of lines) {
      const outcome = parseLine(line, {
        sourceFile,
        fallbackSessionId,
        project,
        fallbackTs: ctx?.fileMtime,
      })
      if (outcome.kind === 'event') events.push(outcome.event)
      else if (outcome.kind === 'malformed') skipped += 1
    }

    return { events, skipped }
  },
}

/**
 * Decode the project path from the encoded project directory.
 *
 * Files may sit directly under it, or nested (subagent transcripts live in
 * <project>/<session-id>/subagents/), so take the first path segment that
 * looks like an encoded project — the one directly under a `projects` dir.
 * The `cwd` field on each entry takes precedence when present; this is only
 * the fallback.
 */
function projectFromPath(sourceFile: string): string | undefined {
  const parts = sourceFile.split(sep)
  const projectsIndex = parts.lastIndexOf('projects')
  const dirName =
    projectsIndex >= 0 && projectsIndex + 1 < parts.length
      ? parts[projectsIndex + 1]
      : parts[parts.length - 2]
  if (dirName === undefined || dirName.length === 0) return undefined
  return decodeProjectDir(dirName)
}

function safeReadDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}
