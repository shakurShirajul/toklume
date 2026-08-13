import { formatCompact } from './api'
import type { DayTotals } from './aggregate'

/**
 * Tokens/day, stacked by token type.
 *
 * Bar height alone tells volume; the stack order (cache read at the base,
 * reasoning at the top) keeps the biggest, cheapest component from drowning
 * out the smaller, costlier ones.
 */
export function TrendChart({ days }: { days: DayTotals[] }) {
  if (days.length === 0) return null

  const H = 130
  const totalOf = (d: DayTotals) =>
    d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens + d.reasoningTokens
  const maxTotal = Math.max(1, ...days.map(totalOf))
  const px = (n: number) => Math.round((n / maxTotal) * H * 10) / 10

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span className="chart-title">tokens / day</span>
        <span className="chart-caption">stacked by token type · {days.length} days</span>
      </div>
      <div className="trend-bars" style={{ height: `${H}px` }}>
        {days.map((d) => {
          const total = totalOf(d)
          const cachePct = total ? Math.round((d.cacheReadTokens / total) * 100) : 0
          return (
            <div
              key={d.date}
              className="trend-bar"
              title={`${d.date} — ${formatCompact(total)} tokens (${cachePct}% cache read)`}
            >
              <div className="trend-seg" style={{ height: `${px(d.cacheReadTokens)}px`, background: 'var(--t-cache-read)' }} />
              <div className="trend-seg" style={{ height: `${px(d.cacheWriteTokens)}px`, background: 'var(--t-cache-write)' }} />
              <div className="trend-seg" style={{ height: `${px(d.inputTokens)}px`, background: 'var(--t-input)' }} />
              <div className="trend-seg" style={{ height: `${px(d.outputTokens)}px`, background: 'var(--t-output)' }} />
              <div className="trend-seg" style={{ height: `${px(d.reasoningTokens)}px`, background: 'var(--t-reasoning)' }} />
            </div>
          )
        })}
      </div>
      <div className="trend-axis">
        <span>{days[0]!.date}</span>
        <span>{days[days.length - 1]!.date}</span>
      </div>
      <div className="chart-legend">
        <span>
          <i style={{ background: 'var(--t-cache-read)' }} /> cache read
        </span>
        <span>
          <i style={{ background: 'var(--t-cache-write)' }} /> cache write
        </span>
        <span>
          <i style={{ background: 'var(--t-input)' }} /> input
        </span>
        <span>
          <i style={{ background: 'var(--t-output)' }} /> output
        </span>
        <span>
          <i style={{ background: 'var(--t-reasoning)' }} /> reasoning
        </span>
      </div>
    </div>
  )
}
