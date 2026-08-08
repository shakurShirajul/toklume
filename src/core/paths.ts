import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync } from 'node:fs'

/**
 * Platform data directory for toklume's own files.
 *
 * Linux:   $XDG_DATA_HOME/toklume or ~/.local/share/toklume
 * macOS:   ~/Library/Application Support/toklume
 * Windows: %APPDATA%\toklume
 */
export function dataDir(): string {
  const home = homedir()
  switch (platform()) {
    case 'win32': {
      const appData = process.env['APPDATA']
      const base = appData && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming')
      return join(base, 'toklume')
    }
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'toklume')
    default: {
      const xdg = process.env['XDG_DATA_HOME']
      const base = xdg && xdg.length > 0 ? xdg : join(home, '.local', 'share')
      return join(base, 'toklume')
    }
  }
}

/** Default database file path. */
export function defaultDbPath(): string {
  return join(dataDir(), 'usage.db')
}

/**
 * Ensure the directory holding `file` exists.
 * Throws a plain Error with an actionable message rather than a raw errno.
 */
export function ensureParentDir(file: string): void {
  const dir = join(file, '..')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new Error(`Cannot create data directory ${dir}: ${errorMessage(err)}`)
  }
}

/** Claude Code log roots: ~/.claude/projects plus $CLAUDE_CONFIG_DIR/projects. */
export function claudeCodeRoots(): string[] {
  const roots: string[] = []
  const configDir = process.env['CLAUDE_CONFIG_DIR']
  if (configDir && configDir.length > 0) {
    // CLAUDE_CONFIG_DIR may hold several paths separated by the platform delimiter.
    for (const part of configDir.split(platform() === 'win32' ? ';' : ':')) {
      const trimmed = part.trim()
      if (trimmed.length > 0) roots.push(join(trimmed, 'projects'))
    }
  }
  roots.push(join(homedir(), '.claude', 'projects'))
  return dedupeExisting(roots)
}

/** Codex log roots: $CODEX_HOME/sessions else ~/.codex/sessions. */
export function codexRoots(): string[] {
  const codexHome = process.env['CODEX_HOME']
  const base = codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
  return dedupeExisting([join(base, 'sessions')])
}

/** OpenCode data roots, which vary by platform and version. */
export function openCodeRoots(): string[] {
  const home = homedir()
  const candidates: string[] = []
  const xdgData = process.env['XDG_DATA_HOME']
  if (xdgData && xdgData.length > 0) candidates.push(join(xdgData, 'opencode'))
  candidates.push(join(home, '.local', 'share', 'opencode'))
  if (platform() === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'opencode'))
  }
  if (platform() === 'win32') {
    const appData = process.env['APPDATA']
    if (appData && appData.length > 0) candidates.push(join(appData, 'opencode'))
  }
  candidates.push(join(home, '.opencode'))
  return dedupeExisting(candidates)
}

function dedupeExisting(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (seen.has(p)) continue
    seen.add(p)
    if (existsSync(p)) out.push(p)
  }
  return out
}

/**
 * Find a bundled asset by walking up from a module's own location.
 *
 * The package runs both from `src/` during development and from `dist/` once
 * bundled, and the depth from module to package root differs between the two.
 * Walking up a few levels resolves the asset in either layout.
 */
export function findUpward(
  moduleUrl: string,
  relativePath: string,
  maxDepth = 5,
): string | null {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, relativePath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Human-readable message for an unknown thrown value.
 *
 * The CLI reports expected failures (unwritable directory, missing database,
 * rejected SQL) as one readable line rather than a stack trace; this is that
 * policy in one place.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Decode a Claude Code project directory name back into a filesystem path.
 *
 * Claude Code encodes the cwd by replacing path separators with '-', which is
 * lossy (a directory whose name contains '-' is indistinguishable from a
 * separator). We only restore the leading separator, which is unambiguous, and
 * otherwise return the raw directory name.
 */
export function decodeProjectDir(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName
  return dirName.replace(/-/g, '/')
}
