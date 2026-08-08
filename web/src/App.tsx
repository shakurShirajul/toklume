import { useEffect, useState } from 'react'
import './App.css'
import {
  fetchDaily,
  fetchMeta,
  fetchSessions,
  runQuery,
  formatCompact,
  formatCost,
  formatCount,
  formatTs,
  shortSessionId,
  type DailyReport,
  type Meta,
  type QueryResult,
  type SessionsReport,
} from './api'
import { CacheBand } from './CacheBand'

type View = 'daily' | 'sessions' | 'console'

const RECIPES: { label: string; sql: string }[] = [
  {
    label: 'cost per project',
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

  useEffect(() => {
    fetchMeta().then(setMeta).catch((err: Error) => setMetaError(err.message))
  }, [])

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          toklume<span className="dim">/ledger</span>
        </h1>
        <p className="tagline">
          Your local token ledger. Read from disk, stored in one SQLite file, never sent anywhere.
        </p>
        {meta && (
          <div className="masthead-stat">
            <b>{formatCount(meta.events)}</b> turns recorded
            <br />
            last sync {meta.lastSyncAt ? formatTs(meta.lastSyncAt) : 'never'}
          </div>
        )}
      </header>

      {metaError && <p className="error">Cannot reach the local API: {metaError}</p>}

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

      {meta && meta.events === 0 ? (
        <p className="empty">
          No usage recorded yet. Run <code>toklume sync</code>, then reload this page.
        </p>
      ) : (
        <>
          {view === 'daily' && <DailyView meta={meta} />}
          {view === 'sessions' && <SessionsView meta={meta} />}
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

function DailyView({ meta }: { meta: Meta | null }) {
  const [report, setReport] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [tool, setTool] = useState('')

  useEffect(() => {
    setError(null)
    fetchDaily({ since, until, tool })
      .then(setReport)
      .catch((err: Error) => setError(err.message))
  }, [since, until, tool])

  const tools = meta?.tools.filter((t) => t.detected && !t.unsupported) ?? []

  return (
    <section>
      <div className="filters">
        <div className="field">
          <label htmlFor="since">from</label>
          <input id="since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="until">to</label>
          <input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tool">tool</label>
          <select id="tool" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">all tools</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>
        {(since || until || tool) && (
          <button
            className="action"
            onClick={() => {
              setSince('')
              setUntil('')
              setTool('')
            }}
          >
            clear
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {report && report.rows.length > 0 && <CacheBand rows={report.rows} />}

      {report && report.rows.length === 0 && !error && (
        <p className="empty">No usage in this range.</p>
      )}

      {report && report.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">date</th>
                  <th className="left">tool</th>
                  <th>input</th>
                  <th>output</th>
                  <th>cache write</th>
                  <th>cache read</th>
                  <th>reasoning</th>
                  <th>est. cost</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={`${row.date}-${row.tool}`}>
                    <td className="left">{row.date}</td>
                    <td className="left muted">{row.tool}</td>
                    <td>{formatCompact(row.inputTokens)}</td>
                    <td>{formatCompact(row.outputTokens)}</td>
                    <td>{formatCompact(row.cacheWriteTokens)}</td>
                    <td>{formatCompact(row.cacheReadTokens)}</td>
                    <td>{row.reasoningTokens > 0 ? formatCompact(row.reasoningTokens) : <span className="muted">—</span>}</td>
                    <td className={row.costUsd === null ? 'muted' : 'cost'}>{formatCost(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="left">total</td>
                  <td />
                  <td>{formatCompact(report.totals.inputTokens)}</td>
                  <td>{formatCompact(report.totals.outputTokens)}</td>
                  <td>{formatCompact(report.totals.cacheWriteTokens)}</td>
                  <td>{formatCompact(report.totals.cacheReadTokens)}</td>
                  <td>{formatCompact(report.totals.reasoningTokens)}</td>
                  <td className={report.totals.costUsd === null ? 'muted' : 'cost'}>
                    {formatCost(report.totals.costUsd)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {report.unknownModels.length > 0 && (
            <p className="warn">
              No bundled rates for {report.unknownModels.join(', ')}. Their cost shows as — rather
              than as zero, so totals including them are marked unknown too.
            </p>
          )}
        </>
      )}
    </section>
  )
}

/* Sessions ---------------------------------------------------------------- */

function SessionsView({ meta }: { meta: Meta | null }) {
  const [report, setReport] = useState<SessionsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tool, setTool] = useState('')
  const [limit, setLimit] = useState(25)

  useEffect(() => {
    setError(null)
    fetchSessions({ tool, limit })
      .then(setReport)
      .catch((err: Error) => setError(err.message))
  }, [tool, limit])

  const tools = meta?.tools.filter((t) => t.detected && !t.unsupported) ?? []

  return (
    <section>
      <div className="filters">
        <div className="field">
          <label htmlFor="stool">tool</label>
          <select id="stool" value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">all tools</option>
            {tools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="limit">show</label>
          <select id="limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100, 250].map((n) => (
              <option key={n} value={n}>
                {n} sessions
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {report && report.rows.length === 0 && !error && <p className="empty">No sessions recorded.</p>}

      {report && report.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">session</th>
                  <th className="left">tool</th>
                  <th className="left">project</th>
                  <th className="left">last activity</th>
                  <th>turns</th>
                  <th>input</th>
                  <th>output</th>
                  <th>cache read</th>
                  <th>est. cost</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={`${row.tool}-${row.sessionId}`}>
                    <td className="left" title={row.sessionId}>
                      {shortSessionId(row.sessionId)}
                    </td>
                    <td className="left muted">{row.tool}</td>
                    <td className="left" title={row.project ?? ''}>
                      {row.project ? basename(row.project) : <span className="muted">—</span>}
                    </td>
                    <td className="left muted">{formatTs(row.lastTs)}</td>
                    <td>
                      {row.turns}
                      {row.sidechainTurns > 0 && (
                        <span className="muted" title="subagent turns, counted in this session">
                          {' '}
                          +{row.sidechainTurns}
                        </span>
                      )}
                    </td>
                    <td>{formatCompact(row.inputTokens)}</td>
                    <td>{formatCompact(row.outputTokens)}</td>
                    <td>{formatCompact(row.cacheReadTokens)}</td>
                    <td className={row.costUsd === null ? 'muted' : 'cost'}>{formatCost(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">
            Subagent turns are rolled into the session that spawned them, shown as +n beside the
            turn count.
          </p>
        </>
      )}
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
    <section className="console-grid">
      <div>
        <div className="recipes">
          {RECIPES.map((recipe) => (
            <button
              key={recipe.label}
              className="recipe"
              onClick={() => {
                setSql(recipe.sql)
                void execute(recipe.sql)
              }}
            >
              {recipe.label}
            </button>
          ))}
        </div>
      </div>

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

      <div className="console-bar">
        <button className="action" disabled={running} onClick={() => void execute(sql)}>
          {running ? 'running…' : 'run query'}
        </button>
        <span className="note" style={{ margin: 0 }}>
          ⌘/Ctrl + Enter to run. The connection is read-only, so writes are rejected by SQLite.
          Tables: <code>events</code>, <code>turn_usage</code>, <code>scan_state</code>.
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      {result && <ResultTable result={result} />}
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
