import { readFileSync } from 'node:fs'
import { findUpward } from './paths.js'

export interface ModelRates {
  input: number
  output: number
  cache_write: number
  cache_read: number
}

export interface PricingTable {
  updated: string
  models: Record<string, ModelRates>
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export const COST_CAPTION =
  'Costs are API-equivalent estimates, not invoices. Subscription plans do not bill per token.'

let cached: PricingTable | undefined

/**
 * Load the bundled pricing table from disk.
 *
 * Pricing is never fetched over the network — it ships with the package and is
 * versioned in git. If the file is missing or unreadable, every model is
 * treated as unknown and costs render as '—' rather than as a wrong number.
 */
export function loadPricing(): PricingTable {
  if (cached) return cached
  const path = findUpward(import.meta.url, 'data/pricing.json')
  if (!path) {
    cached = { updated: 'unknown', models: {} }
    return cached
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PricingTable
    cached = {
      updated: typeof parsed.updated === 'string' ? parsed.updated : 'unknown',
      models: parsed.models ?? {},
    }
  } catch {
    cached = { updated: 'unknown', models: {} }
  }
  return cached
}

/**
 * Memoized model -> rates resolution, keyed by table then model id.
 *
 * Reports resolve rates once per (day × tool × model) group, and every lookup
 * that is not an exact hit scans the whole table. Caching keeps that scan to
 * once per distinct model id.
 */
const rateCache = new WeakMap<PricingTable, Map<string, ModelRates | null>>()

/**
 * Resolve rates for a model id by longest-prefix match, so dated variants such
 * as `claude-opus-5-20250514` resolve to the `claude-opus-5` entry.
 */
export function ratesFor(model: string, table: PricingTable = loadPricing()): ModelRates | null {
  let perTable = rateCache.get(table)
  if (!perTable) {
    perTable = new Map()
    rateCache.set(table, perTable)
  }

  const memoized = perTable.get(model)
  if (memoized !== undefined) return memoized

  const resolved = resolveRates(model, table)
  perTable.set(model, resolved)
  return resolved
}

function resolveRates(model: string, table: PricingTable): ModelRates | null {
  const direct = table.models[model]
  if (direct) return direct

  let best: ModelRates | null = null
  let bestLength = -1
  for (const [prefix, rates] of Object.entries(table.models)) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = rates
      bestLength = prefix.length
    }
  }
  return best
}

/**
 * Estimated USD cost for a set of token counts, or null when the model has no
 * bundled rates. Null propagates to '—' in output; it never becomes 0.
 *
 * Reasoning tokens are billed at the output rate (they are output tokens the
 * model did not show you).
 */
export function costOf(model: string, counts: TokenCounts, table?: PricingTable): number | null {
  const rates = ratesFor(model, table)
  if (!rates) return null

  const perMillion =
    counts.inputTokens * rates.input +
    counts.outputTokens * rates.output +
    counts.cacheWriteTokens * rates.cache_write +
    counts.cacheReadTokens * rates.cache_read +
    counts.reasoningTokens * rates.output

  return perMillion / 1_000_000
}

/** True when the model has no bundled rates. */
export function isUnknownModel(model: string, table?: PricingTable): boolean {
  return ratesFor(model, table) === null
}

/** Sum of every token class. */
export function totalOf(counts: TokenCounts): number {
  return (
    counts.inputTokens +
    counts.outputTokens +
    counts.cacheWriteTokens +
    counts.cacheReadTokens +
    counts.reasoningTokens
  )
}

/** Accumulate `src` into `target` in place. */
export function addCounts(target: TokenCounts, src: TokenCounts): void {
  target.inputTokens += src.inputTokens
  target.outputTokens += src.outputTokens
  target.cacheWriteTokens += src.cacheWriteTokens
  target.cacheReadTokens += src.cacheReadTokens
  target.reasoningTokens += src.reasoningTokens
}

/**
 * Add two possibly-unknown costs.
 *
 * An unknown component makes the sum unknown: reporting a partial total as if
 * it were complete would understate spend.
 */
export function addCost(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a + b
}
