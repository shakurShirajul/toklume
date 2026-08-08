import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Defensive-parsing primitives shared by every parser.
 *
 * Agent log formats vary across versions and can be truncated mid-write, so
 * parsers treat every field as optional and coerce rather than trust. These
 * helpers encode that contract in one place: if the rule for what counts as a
 * usable number or string changes, it changes for all tools at once.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Non-empty string, else undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Non-negative integer token count; anything unusable becomes 0. */
export function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

/**
 * ISO 8601 string or epoch number to unix seconds.
 *
 * Values past 1e11 are treated as milliseconds — that threshold is ~1973 in
 * seconds and ~1970 in milliseconds, so any plausible agent log timestamp
 * lands on the correct side of it.
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 1e11 ? value / 1000 : value)
  }
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

/**
 * Fast non-cryptographic hash (FNV-1a, four independently seeded 32-bit lanes
 * combined into a 128-bit hex digest).
 *
 * Used only to build dedupe keys for log lines that carry no message id. A
 * single 32-bit lane would collide by birthday paradox at ~77k lines, which is
 * well within a real user's history; four lanes make accidental collisions
 * negligible. Not used for anything security-sensitive.
 */
export function hash128(input: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9]
  const lanes = new Uint32Array(seeds)

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    for (let lane = 0; lane < lanes.length; lane++) {
      const h = lanes[lane]! ^ (code + lane)
      // h *= 16777619 (the FNV prime), kept in 32-bit integer math.
      lanes[lane] = Math.imul(h, 0x01000193) >>> 0
    }
  }

  let out = ''
  for (const lane of lanes) out += lane.toString(16).padStart(8, '0')
  return out
}

/** Short hash, for dedupe keys that only need a content discriminator. */
export function hash8(input: string): string {
  return hash128(input).slice(0, 8)
}

/**
 * Recursively collect files with the given extension.
 *
 * Unreadable directories are skipped rather than aborting the walk: a single
 * permission-denied project directory must not stop a sync. `maxDepth` bounds
 * the recursion so a symlink cycle cannot spin forever.
 */
export function collectFiles(
  dir: string,
  out: string[],
  options: { extension: string; maxDepth: number },
  depth = 0,
): void {
  if (depth > options.maxDepth) return

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out, options, depth + 1)
    else if (entry.isFile() && entry.name.endsWith(options.extension)) out.push(full)
  }
}
