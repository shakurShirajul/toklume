import type { DailyRow } from './api'

export interface DayTotals {
  date: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

/** Folds per-tool daily rows into one totals row per day, sorted ascending by date. */
export function groupByDay(rows: DailyRow[]): DayTotals[] {
  const byDay = new Map<string, DayTotals>()
  for (const row of rows) {
    const day = byDay.get(row.date) ?? {
      date: row.date,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    }
    day.inputTokens += row.inputTokens
    day.outputTokens += row.outputTokens
    day.cacheWriteTokens += row.cacheWriteTokens
    day.cacheReadTokens += row.cacheReadTokens
    day.reasoningTokens += row.reasoningTokens
    byDay.set(row.date, day)
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}
