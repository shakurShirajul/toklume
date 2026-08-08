import type { Db } from '../db/index.js'
import { addCost, addCounts, costOf, ratesFor, totalOf, type TokenCounts } from '../core/pricing.js'

export interface DailyFilters {
  since?: string | undefined // YYYY-MM-DD (local)
  until?: string | undefined // YYYY-MM-DD (local, inclusive)
  tool?: string | undefined
}

export interface DailyRow {
  date: string // YYYY-MM-DD, local time
  tool: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  /** null when any contributing model has no bundled pricing. */
  costUsd: number | null
}

export interface DailyReport {
  rows: DailyRow[]
  totals: DailyRow
  /** Models seen in the range that have no bundled rates. */
  unknownModels: string[]
}

interface RawRow {
  date: string
  tool: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
}

/**
 * Per-day, per-tool token rollup with estimated cost.
 *
 * Reads `turn_usage` (never `events`) so cumulative sources are delta-corrected.
 * Grouping happens per model as well, because cost depends on the model; the
 * model dimension is then folded away after costing.
 *
 * Dates are bucketed in local time via SQLite's 'localtime' modifier so a day
 * boundary matches what the user saw on their own clock.
 */
export function dailyReport(db: Db, filters: DailyFilters = {}): DailyReport {
  const where: string[] = []
  const params: Record<string, string> = {}

  if (filters.tool) {
    where.push('tool = @tool')
    params['tool'] = filters.tool
  }
  if (filters.since) {
    where.push("DATE(ts, 'unixepoch', 'localtime') >= @since")
    params['since'] = filters.since
  }
  if (filters.until) {
    where.push("DATE(ts, 'unixepoch', 'localtime') <= @until")
    params['until'] = filters.until
  }

  const sql = `
    SELECT
      DATE(ts, 'unixepoch', 'localtime') AS date,
      tool,
      model,
      SUM(input_tokens)       AS input_tokens,
      SUM(output_tokens)      AS output_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(cache_read_tokens)  AS cache_read_tokens,
      SUM(reasoning_tokens)   AS reasoning_tokens
    FROM turn_usage
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY date, tool, model
    ORDER BY date ASC, tool ASC
  `

  const raw = db.prepare<Record<string, string>, RawRow>(sql).all(params)

  const byDateTool = new Map<string, DailyRow>()
  const unknown = new Set<string>()

  for (const row of raw) {
    const counts: TokenCounts = {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheReadTokens: row.cache_read_tokens,
      reasoningTokens: row.reasoning_tokens,
    }
    // One rate resolution per row serves both the cost and the unknown check.
    if (ratesFor(row.model) === null) unknown.add(row.model)
    const cost = costOf(row.model, counts)

    const key = `${row.date} ${row.tool}`
    let existing = byDateTool.get(key)
    if (!existing) {
      existing = {
        date: row.date,
        tool: row.tool,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      }
      byDateTool.set(key, existing)
    }

    addCounts(existing, counts)
    existing.totalTokens += totalOf(counts)
    existing.costUsd = addCost(existing.costUsd, cost)
  }

  const rows = [...byDateTool.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.tool.localeCompare(b.tool),
  )

  return { rows, totals: sumRows(rows), unknownModels: [...unknown].sort() }
}

function sumRows(rows: DailyRow[]): DailyRow {
  const totals: DailyRow = {
    date: 'TOTAL',
    tool: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  }
  for (const row of rows) {
    addCounts(totals, row)
    totals.totalTokens += row.totalTokens
    totals.costUsd = addCost(totals.costUsd, row.costUsd)
  }
  return totals
}
