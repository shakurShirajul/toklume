import { formatCompact } from './api'
import type { DayTotals } from './aggregate'

/**
 * The cache-ratio ledger band.
 *
 * Token tables bury the single most surprising fact about agent usage: cache
 * reads usually dwarf everything else by one or two orders of magnitude. One
 * proportional band per day makes that legible at a glance, and makes an
 * unusually cache-cold day obvious without reading a number.
 */
export function CacheBand({ days: allDays }: { days: DayTotals[] }) {
  const days = allDays.slice(-21)
  if (days.length === 0) return null

  const bands = days.map((d) => ({
    date: d.date,
    cache: d.cacheReadTokens,
    fresh: d.inputTokens + d.cacheWriteTokens,
    out: d.outputTokens + d.reasoningTokens,
  }))

  const overall = bands.reduce(
    (acc, b) => ({
      cache: acc.cache + b.cache,
      total: acc.total + b.cache + b.fresh + b.out,
    }),
    { cache: 0, total: 0 },
  )
  const overallPct = overall.total > 0 ? (overall.cache / overall.total) * 100 : 0

  return (
    <section className="band-block">
      <div className="band-head">
        <span className="band-title">cache band · read vs fresh</span>
        <span className="chart-caption accent" style={{ fontWeight: 600 }}>
          {overallPct.toFixed(1)}% cached
        </span>
      </div>

      <div className="band-rows">
        {bands.map((b) => {
          const total = b.cache + b.fresh + b.out
          if (total === 0) return null
          const pct = (n: number) => (n / total) * 100
          const cachePct = pct(b.cache)
          return (
            <div className="band-row" key={b.date}>
              <span className="band-date">{b.date.slice(5)}</span>
              <span
                className="band-track"
                role="img"
                aria-label={`${b.date}: ${cachePct.toFixed(0)}% cache reads, ${formatCompact(
                  total,
                )} tokens total`}
              >
                <span className="band-seg cache" style={{ width: `${cachePct}%` }} />
                <span className="band-seg fresh" style={{ width: `${pct(b.fresh)}%` }} />
                <span className="band-seg out" style={{ width: `${pct(b.out)}%` }} />
              </span>
              <span className="band-pct">{formatCompact(total)}</span>
            </div>
          )
        })}
      </div>

      <div className="legend">
        <span>
          <i className="swatch cache" /> cache read
        </span>
        <span>
          <i className="swatch fresh" /> fresh input + cache write
        </span>
        <span>
          <i className="swatch out" /> output + reasoning
        </span>
      </div>
    </section>
  )
}
