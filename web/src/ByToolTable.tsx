import { formatCompact, formatCost, type DailyRow } from './api'

/**
 * One row per tool: share of tokens as a bar, plus totals for the same
 * range the daily table shows. Answers "which tool is actually driving
 * spend" without cross-referencing the trend chart by eye.
 */
export function ByToolTable({ rows }: { rows: DailyRow[] }) {
  const byTool = new Map<
    string,
    { tokens: number; cost: number; unknownCost: boolean; cacheRead: number; days: Set<string> }
  >()
  for (const row of rows) {
    const t = byTool.get(row.tool) ?? {
      tokens: 0,
      cost: 0,
      unknownCost: false,
      cacheRead: 0,
      days: new Set<string>(),
    }
    t.tokens += row.totalTokens
    t.cacheRead += row.cacheReadTokens
    if (row.costUsd === null) t.unknownCost = true
    else t.cost += row.costUsd
    t.days.add(row.date)
    byTool.set(row.tool, t)
  }

  const entries = [...byTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
  if (entries.length === 0) return null

  const maxTokens = Math.max(1, ...entries.map(([, t]) => t.tokens))

  return (
    <div className="bytool">
      <div className="bytool-head">
        <span>by tool</span>
        <span>share of tokens</span>
        <span className="right">tokens</span>
        <span className="right">est. cost</span>
        <span className="right">cached</span>
        <span className="right">days</span>
      </div>
      {entries.map(([tool, t]) => (
        <div className="bytool-row" key={tool}>
          <span>{tool}</span>
          <span className="bytool-track">
            <span className="bytool-bar" style={{ width: `${(t.tokens / maxTokens) * 100}%` }} />
          </span>
          <span className="right">{formatCompact(t.tokens)}</span>
          <span className={t.unknownCost && t.cost === 0 ? 'right muted' : 'right'}>
            {t.unknownCost && t.cost === 0 ? formatCost(null) : formatCost(t.cost, t.unknownCost)}
          </span>
          <span className="right cache-read">{Math.round((t.cacheRead / t.tokens) * 100)}%</span>
          <span className="right muted">{t.days.size}</span>
        </div>
      ))}
    </div>
  )
}
