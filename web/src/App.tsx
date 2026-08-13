import { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  fetchDaily,
  fetchMeta,
  fetchSessions,
  runQuery,
  triggerSync,
  formatCompact,
  formatCost,
  formatCount,
  formatTs,
  shortSessionId,
  type DailyReport,
  type Meta,
  type QueryResult,
  type SessionsReport,
  type SyncResult,
} from './api'
import { CacheBand } from './CacheBand'
import { TrendChart } from './TrendChart'
import { ByToolTable } from './ByToolTable'
import { groupByDay } from './aggregate'
import { highlightSql } from './sqlHighlight'

type View = 'daily' | 'sessions' | 'console'
type Theme = 'dark' | 'light'
type Range = 7 | 30 | 90

const THEME_KEY = 'toklume-theme'

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  return [theme, toggle]
}

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - (n - 1))
  return d.toISOString().slice(0, 10)
}

const RECIPES: { label: string; desc: string; sql: string }[] = [
  {
    label: 'cost per project',
    desc: 'tokens + turns grouped by project',
    sql: `SELECT project,
       SUM(input_tokens + output_tokens) AS tokens,
       COUNT(*) AS turns
FROM turn_usage
WHERE project IS NOT NULL
GROUP BY project
ORDER BY tokens DESC
LIMIT 20`,
  },
  {
    label: 'cache hit ratio by day',
    desc: 'cached vs fresh input per day',
    sql: `SELECT DATE(ts,'unixepoch','localtime') AS day,
       ROUND(1.0 * SUM(cache_read_tokens) /
             NULLIF(SUM(cache_read_tokens + input_tokens), 0), 4) AS cache_ratio,
       SUM(cache_read_tokens) AS cached,
       SUM(input_tokens) AS fresh
FROM turn_usage
GROUP BY day
ORDER BY day DESC
LIMIT 21`,
  },
  {
    label: 'tokens by model per week',
    desc: 'wide result — model × week',
    sql: `SELECT STRFTIME('%Y-W%W', ts, 'unixepoch', 'localtime') AS week,
       model,
       SUM(input_tokens + output_tokens + reasoning_tokens) AS tokens
FROM turn_usage
GROUP BY week, model
ORDER BY week DESC, tokens DESC
LIMIT 40`,
  },
  {
    label: 'busiest sessions',
    desc: 'sessions ranked by output tokens',
    sql: `SELECT session_id, tool, COUNT(*) AS turns,
       SUM(output_tokens) AS output
FROM turn_usage
GROUP BY tool, session_id
ORDER BY output DESC
LIMIT 15`,
  },
]

export default function App() {
  const [view, setView] = useState<View>('daily')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [theme, toggleTheme] = useTheme()
  const [tool, setTool] = useState('')
  const [range, setRange] = useState<Range>(30)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    fetchMeta().then(setMeta).catch((err: Error) => setMetaError(err.message))
  }, [refreshKey])

  const tools = meta?.tools.filter((t) => t.detected && !t.unsupported) ?? []

  const sync = async () => {
    setSyncing(true)
    setSyncError(null)
    try {
      const result: SyncResult = await triggerSync()
      const failed = result.tools.find((t) => t.failures && t.failures.length > 0)
      if (failed?.failures?.[0]) {
        setSyncError(`${failed.tool}: ${failed.failures[0].error}`)
      }
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setSyncError((err as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          <button type="button" className="wordmark-link" onClick={() => setView('daily')}>
            toklume<span className="dim">/ledger</span>
          </button>
        </h1>
        <nav className="tabs" role="tablist" aria-label="Views">
          {(
            [
              ['daily', 'daily'],
              ['sessions', 'sessions'],
              ['console', 'sql console'],
            ] as [View, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              className="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button
          className="theme-toggle"
          onClick={() => void sync()}
          disabled={syncing}
          title="Scan agent logs and ingest new usage"
        >
          {syncing ? '⟳ syncing…' : '⟳ sync'}
        </button>
        <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
          {theme === 'light' ? '◑ dark' : '◐ light'}
        </button>
      </header>

      {metaError && <p className="error">Cannot reach the local API: {metaError}</p>}
      {syncError && <p className="error">Sync failed: {syncError}</p>}

      {meta && (
        <div className="meta-strip">
          <span>
            <b>{formatCount(meta.events)}</b> events
          </span>
          <span>
            last sync <b>{meta.lastSyncAt ? formatTs(meta.lastSyncAt) : 'never'}</b>
          </span>
          <span className="meta-tools">
            tools
            {meta.tools.map((t) => (
              <span key={t.id} className={t.detected && !t.unsupported ? 'meta-tool ok' : 'meta-tool'}>
                {t.detected && !t.unsupported ? '✓' : '·'} {t.id}
              </span>
            ))}
          </span>
          <span>
            <b>{meta.models.length}</b> models seen
          </span>
          <span>
            pricing <b>{meta.pricingUpdated}</b>
          </span>
          <span className="spacer" />
          <span>local · sqlite · no telemetry</span>
        </div>
      )}

      {meta && meta.events > 0 && (
        <div className="filter-bar">
          <span className="filter-label">tool</span>
          <div className="segmented">
            <button className={tool === '' ? 'seg on' : 'seg'} onClick={() => setTool('')}>
              all
            </button>
            {tools.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? 'seg on' : 'seg'}
                onClick={() => setTool(t.id)}
              >
                {t.id}
              </button>
            ))}
          </div>
          {view === 'daily' && (
            <>
              <span className="filter-label">range</span>
              <div className="segmented">
                {([7, 30, 90] as Range[]).map((n) => (
                  <button key={n} className={range === n ? 'seg on' : 'seg'} onClick={() => setRange(n)}>
                    {n}d
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {meta && meta.events === 0 ? (
        <p className="empty">
          No usage recorded yet. Run <code>toklume sync</code>, then reload this page.
        </p>
      ) : (
        <>
          {view === 'daily' && <DailyView tool={tool} range={range} refreshKey={refreshKey} />}
          {view === 'sessions' && <SessionsView tool={tool} refreshKey={refreshKey} />}
          {view === 'console' && <ConsoleView />}
        </>
      )}

      <footer className="footer">
        <span>Costs are API-equivalent estimates, not invoices. Subscription plans do not bill per token.</span>
        {meta && <span>pricing table {meta.pricingUpdated}</span>}
      </footer>
    </div>
  )
}

/* Daily ------------------------------------------------------------------- */

function DailyView({ tool, range, refreshKey }: { tool: string; range: Range; refreshKey: number }) {
  const [report, setReport] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const since = useMemo(() => isoDaysAgo(range), [range])

  useEffect(() => {
    setError(null)
    fetchDaily({ since, tool })
      .then(setReport)
      .catch((err: Error) => setError(err.message))
  }, [since, tool, refreshKey])

  if (error) return <p className="error">{error}</p>
  if (!report) return null

  if (report.rows.length === 0) {
    return <p className="empty">No usage in this range.</p>
  }

  const days = groupByDay(report.rows)

  return (
    <section>
      <div className="chart-row">
        <TrendChart days={days} />
        <CacheBand days={days} />
      </div>

      <ByToolTable rows={report.rows} />

      <div className="daily-grid table-wrap">
        <div className="daily-grid-inner">
          <div className="grid-head daily-cols">
            <span>date</span>
            <span>tool</span>
            <span className="right">input</span>
            <span className="right">output</span>
            <span className="right">cache w</span>
            <span className="right cache-read">cache r</span>
            <span className="right">reasoning</span>
            <span className="right">total</span>
            <span className="right">est. cost*</span>
          </div>
          {report.rows.map((row, i) => {
            const first = i === 0 || row.date !== report.rows[i - 1]!.date
            return (
              <div
                className={first ? 'grid-row daily-cols first' : 'grid-row daily-cols'}
                key={`${row.date}-${row.tool}`}
              >
                <span className="muted">{first ? row.date : ''}</span>
                <span className="muted">{row.tool}</span>
                <span className="right">{formatCompact(row.inputTokens)}</span>
                <span className="right">{formatCompact(row.outputTokens)}</span>
                <span className="right">{formatCompact(row.cacheWriteTokens)}</span>
                <span className="right cache-read">{formatCompact(row.cacheReadTokens)}</span>
                <span className={row.reasoningTokens > 0 ? 'right' : 'right muted'}>
                  {row.reasoningTokens > 0 ? formatCompact(row.reasoningTokens) : '—'}
                </span>
                <span className="right muted">{formatCompact(row.totalTokens)}</span>
                <span
                  className={row.costUsd === null ? 'right muted' : 'right cost'}
                  title={row.costUsd === null ? 'no bundled rate for this model — unknown, not zero' : 'API-equivalent estimate'}
                >
                  {formatCost(row.costUsd)}
                </span>
              </div>
            )
          })}
          <div className="grid-row daily-cols total">
            <span>total</span>
            <span />
            <span className="right">{formatCompact(report.totals.inputTokens)}</span>
            <span className="right">{formatCompact(report.totals.outputTokens)}</span>
            <span className="right">{formatCompact(report.totals.cacheWriteTokens)}</span>
            <span className="right cache-read">{formatCompact(report.totals.cacheReadTokens)}</span>
            <span className="right">{formatCompact(report.totals.reasoningTokens)}</span>
            <span className="right">{formatCompact(report.totals.totalTokens)}</span>
            <span className="right">{formatCost(report.totals.costUsd)}</span>
          </div>
        </div>
      </div>

      <div className="footnotes">
        <span>* estimates computed at query time from the bundled pricing table — never invoices.</span>
        {report.unknownModels.length > 0 && (
          <span>
            — = no bundled rate ({report.unknownModels.join(', ')}); never rendered as $0.00. Totals
            containing unpriced rows show as ≥.
          </span>
        )}
      </div>
    </section>
  )
}

/* Sessions ---------------------------------------------------------------- */

type SessionTokenField =
  | 'cacheReadTokens'
  | 'inputTokens'
  | 'cacheWriteTokens'
  | 'outputTokens'
  | 'reasoningTokens'

const SESSION_COMPONENTS: {
  key: SessionTokenField
  label: string
  color: string
}[] = [
  { key: 'cacheReadTokens', label: 'cache read', color: 'var(--t-cache-read)' },
  { key: 'inputTokens', label: 'input', color: 'var(--t-input)' },
  { key: 'cacheWriteTokens', label: 'cache write', color: 'var(--t-cache-write)' },
  { key: 'outputTokens', label: 'output', color: 'var(--t-output)' },
  { key: 'reasoningTokens', label: 'reasoning', color: 'var(--t-reasoning)' },
]

function SessionsView({ tool, refreshKey }: { tool: string; refreshKey: number }) {
  const [report, setReport] = useState<SessionsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(50)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    fetchSessions({ tool, limit })
      .then(setReport)
      .catch((err: Error) => setError(err.message))
  }, [tool, limit, refreshKey])

  if (error) return <p className="error">{error}</p>
  if (report && report.rows.length === 0) return <p className="empty">No sessions recorded.</p>
  if (!report) return null

  return (
    <section>
      <div className="table-wrap sessions-grid">
        <div className="sessions-grid-inner">
          <div className="grid-head session-cols">
            <span />
            <span>session</span>
            <span>tool</span>
            <span>project</span>
            <span>last activity</span>
            <span className="right">turns</span>
            <span className="right">input</span>
            <span className="right">output</span>
            <span className="right cache-read">cache r</span>
            <span className="right">est. cost*</span>
          </div>
          {report.rows.map((row) => {
            const key = `${row.tool}-${row.sessionId}`
            const isOpen = expanded === key
            const total = row.totalTokens
            return (
              <div key={key}>
                <div
                  className="grid-row session-cols clickable"
                  onClick={() => setExpanded(isOpen ? null : key)}
                >
                  <span className="muted">{isOpen ? '▾' : '▸'}</span>
                  <span className="accent" title={row.sessionId}>
                    {shortSessionId(row.sessionId)}
                  </span>
                  <span className="muted">{row.tool}</span>
                  <span className="ellipsis" title={row.project ?? ''}>
                    {row.project ? basename(row.project) : <span className="muted">—</span>}
                  </span>
                  <span className="muted">{formatTs(row.lastTs)}</span>
                  <span className="right">
                    {row.turns}
                    {row.sidechainTurns > 0 && (
                      <span className="muted" title="subagent turns, counted in this session">
                        {' '}
                        +{row.sidechainTurns}
                      </span>
                    )}
                  </span>
                  <span className="right">{formatCompact(row.inputTokens)}</span>
                  <span className="right">{formatCompact(row.outputTokens)}</span>
                  <span className="right cache-read">{formatCompact(row.cacheReadTokens)}</span>
                  <span
                    className={row.costUsd === null ? 'right muted' : 'right cost'}
                    title={
                      row.costUsd === null
                        ? `no bundled rate for ${row.models[0] ?? 'this model'} — unknown, not zero`
                        : 'API-equivalent estimate'
                    }
                  >
                    {formatCost(row.costUsd)}
                  </span>
                </div>
                {isOpen && (
                  <div className="session-detail">
                    <div className="session-detail-meta">
                      <span>
                        id <b>{row.sessionId}</b>
                      </span>
                      <span>
                        started <b>{formatTs(row.firstTs)}</b>
                      </span>
                      <span>
                        models <b>{row.models.join(', ')}</b>
                      </span>
                      <span>
                        {row.sidechainTurns > 0
                          ? `${row.turns} main turns + ${row.sidechainTurns} subagent (sidechain) — billed to this session`
                          : `${row.turns} turns, no subagents`}
                      </span>
                    </div>
                    <div className="session-detail-bars">
                      {SESSION_COMPONENTS.map((c) => {
                        const v = row[c.key]
                        if (v <= 0) return null
                        return (
                          <div className="session-bar-row" key={c.key}>
                            <span className="muted">{c.label}</span>
                            <span className="session-bar-track">
                              <span
                                className="session-bar-fill"
                                style={{
                                  width: `${Math.max(0.4, (v / total) * 100)}%`,
                                  background: c.color,
                                }}
                              />
                            </span>
                            <span className="session-bar-val">{formatCompact(v)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="footnotes">
        <span>
          +n marks subagent (sidechain) turns — counted inside their parent session, never as
          separate sessions. Click a row to expand.
        </span>
        <label className="limit-select">
          show
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100, 250].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

/* SQL console ------------------------------------------------------------- */

function ConsoleView() {
  const [sql, setSql] = useState(RECIPES[0]!.sql)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const execute = async (statement: string) => {
    setRunning(true)
    setError(null)
    try {
      setResult(await runQuery(statement))
    } catch (err) {
      setError((err as Error).message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="console-layout">
      <div className="recipes-panel">
        <div className="recipes-head">recipes</div>
        {RECIPES.map((recipe) => (
          <button
            key={recipe.label}
            className={sql === recipe.sql ? 'recipe on' : 'recipe'}
            onClick={() => {
              setSql(recipe.sql)
              void execute(recipe.sql)
            }}
          >
            <span className="recipe-label">{recipe.label}</span>
            <span className="recipe-desc">{recipe.desc}</span>
          </button>
        ))}
        <div className="recipes-foot">
          Tables: <span className="ink2">events · turn_usage · scan_state</span>
          <br />
          Connection is read-only — writes are rejected by SQLite.
        </div>
      </div>

      <div className="console-editor-col">
        <div className="sql-editor">
          <pre aria-hidden="true" className="sql-highlight">
            {highlightSql(sql)}
          </pre>
          <textarea
            className="sql"
            value={sql}
            spellCheck={false}
            aria-label="SQL to run"
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void execute(sql)
            }}
          />
        </div>

        <div className="console-bar">
          <button className="action" disabled={running} onClick={() => void execute(sql)}>
            {running ? 'running…' : 'run'}
          </button>
          <span className="note" style={{ margin: 0 }}>
            ⌘/Ctrl + Enter to run · read-only
          </span>
          <span className="spacer" />
          {result && (
            <span className="note" style={{ margin: 0 }}>
              {formatCount(result.rows.length)} rows
            </span>
          )}
        </div>

        {error && (
          <div className="sql-error">
            <b>SQLITE_ERROR</b> · {error}
          </div>
        )}

        {!error && !result && !running && (
          <p className="empty">No query run yet. Load a recipe on the left, tweak it, and run.</p>
        )}

        {result && <ResultTable result={result} />}
      </div>
    </section>
  )
}

function ResultTable({ result }: { result: QueryResult }) {
  const columns = result.columns

  if (result.rows.length === 0) {
    return <p className="empty">Query ran successfully and returned no rows.</p>
  }

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col} className="left">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col} className={typeof row[col] === 'number' ? '' : 'left'}>
                    {renderCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        {formatCount(result.rows.length)} row{result.rows.length === 1 ? '' : 's'}
        {result.truncated && ` shown of ${formatCount(result.totalRows ?? 0)} — add a LIMIT to see the rest`}
      </p>
    </div>
  )
}

function renderCell(value: unknown) {
  if (value === null || value === undefined) return <span className="muted">null</span>
  if (typeof value === 'number') return formatCount(value)
  return String(value)
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}
