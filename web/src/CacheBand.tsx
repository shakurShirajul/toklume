import { formatCompact, type DailyRow } from './api'

/**
 * The cache-ratio ledger band.
 *
 * Token tables bury the single most surprising fact about agent usage: cache
 * reads usually dwarf everything else by one or two orders of magnitude. One
 * proportional band per day makes that legible at a glance, and makes an
 * unusually cache-cold day obvious without reading a number.
 */
export function CacheBand({ rows }: { rows: DailyRow[] }) {
  // Fold the per-tool rows into one row per day.
  const byDay = new Map<string, { cache: number; fresh: number; out: number }>()
  for (const row of rows) {
    const day = byDay.get(row.date) ?? { cache: 0, fresh: 0, out: 0 }
    day.cache += row.cacheReadTokens
    day.fresh += row.inputTokens + row.cacheWriteTokens
    day.out += row.outputTokens + row.reasoningTokens
    byDay.set(row.date, day)
  }

  const days = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 21)
    .reverse()

  if (days.length === 0) return null

  const overall = days.reduce(
    (acc, [, d]) => ({
      cache: acc.cache + d.cache,
      total: acc.total + d.cache + d.fresh + d.out,
    }),
    { cache: 0, total: 0 },
  )
  const overallPct = overall.total > 0 ? (overall.cache / overall.total) * 100 : 0

  return (
    <section className="band-block">
      <div className="band-head">
        <h2 className="band-title">Where the tokens actually go</h2>
        <span className="band-title">{overallPct.toFixed(1)}% cached</span>
      </div>
      <p className="band-lede">
        Each band is one day, split by proportion. Cache reads are billed at a fraction of fresh
        input, so a wide sand-coloured band is cheap volume — not spend.
      </p>

      <div className="band-rows">
        {days.map(([date, d]) => {
          const total = d.cache + d.fresh + d.out
          if (total === 0) return null
          const pct = (n: number) => (n / total) * 100
          const cachePct = pct(d.cache)
          return (
            <div className="band-row" key={date}>
              <span className="band-date">{date.slice(5)}</span>
              <span
                className="band-track"
                role="img"
                aria-label={`${date}: ${cachePct.toFixed(0)}% cache reads, ${formatCompact(
                  total,
                )} tokens total`}
              >
                <span className="band-seg cache" style={{ width: `${cachePct}%` }} />
                <span className="band-seg fresh" style={{ width: `${pct(d.fresh)}%` }} />
                <span className="band-seg out" style={{ width: `${pct(d.out)}%` }} />
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
