import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, normalize, extname } from 'node:path'
import { openDb, type Db } from '../db/index.js'
import { dailyReport } from '../reports/daily.js'
import { sessionsReport } from '../reports/sessions.js'
import { COST_CAPTION, loadPricing } from '../core/pricing.js'
import { errorMessage, findUpward } from '../core/paths.js'
import { detectSources, type DetectedSource } from '../parsers/registry.js'
import { distinctModels, eventCount, lastSyncAt } from '../db/queries.js'
import { runSync } from '../core/sync.js'

export interface WebServerOptions {
  dbPath?: string | undefined
  port: number
  host: string
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

/**
 * Local dashboard server.
 *
 * Binds to the loopback interface only and makes no outbound requests: it
 * reads the same local database the CLI does and serves a static bundle. The
 * report functions are shared with the CLI so both surfaces agree by
 * construction.
 */
export function createWebServer(options: WebServerOptions) {
  // The bundle lives at web/dist; resolve it from src/ or from dist/ alike.
  const indexHtml = findUpward(import.meta.url, 'web/dist/index.html')
  const assetDir = indexHtml === null ? null : dirname(indexHtml)

  // Source detection walks every agent log tree, which is far too expensive to
  // repeat per request. Installed tools do not change while the server runs, so
  // detect once and reuse. Restart the server to pick up a newly installed tool.
  const sources = detectSources()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)

    // The one write path: triggering a sync from the dashboard's sync button.
    // Everything else stays strictly read-only.
    if (url.pathname === '/api/sync') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Only POST is supported' })
        return
      }
      handleSync(req, res, options.dbPath)
      return
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Only GET is supported' })
      return
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        handleApi(url, res, options.dbPath, sources)
        return
      }
      serveStatic(url.pathname, res, assetDir)
    } catch (err) {
      sendJson(res, 500, { error: errorMessage(err) })
    }
  })

  return { server, assetDir }
}

function handleApi(
  url: URL,
  res: ServerResponse,
  dbPath: string | undefined,
  sources: DetectedSource[],
): void {
  // Each request opens its own read-only handle. SQLite handles this cheaply,
  // and a read-only connection means the dashboard can never mutate the DB.
  let db: Db
  try {
    db = openDb({ dbPath, readonly: true })
  } catch (err) {
    sendJson(res, 503, { error: errorMessage(err) })
    return
  }

  try {
    switch (url.pathname) {
      case '/api/daily': {
        const report = dailyReport(db, {
          since: url.searchParams.get('since') ?? undefined,
          until: url.searchParams.get('until') ?? undefined,
          tool: url.searchParams.get('tool') ?? undefined,
        })
        sendJson(res, 200, { ...report, caption: COST_CAPTION })
        return
      }

      case '/api/sessions': {
        const parsed = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
        const report = sessionsReport(db, {
          tool: url.searchParams.get('tool') ?? undefined,
          limit: Number.isFinite(parsed) ? parsed : 50,
        })
        sendJson(res, 200, { ...report, caption: COST_CAPTION })
        return
      }

      case '/api/meta': {
        const pricing = loadPricing()
        const events = eventCount(db)
        sendJson(res, 200, {
          events,
          lastSyncAt: lastSyncAt(db),
          pricingUpdated: pricing.updated,
          models: distinctModels(db),
          tools: sources.map((source) => ({
            id: source.parser.id,
            displayName: source.parser.displayName,
            detected: source.roots.length > 0,
            unsupported: source.unsupported,
          })),
          caption: COST_CAPTION,
        })
        return
      }

      case '/api/query': {
        const sql = url.searchParams.get('sql')
        if (!sql || sql.trim().length === 0) {
          sendJson(res, 400, { error: 'Provide a ?sql= parameter' })
          return
        }
        runUserQuery(db, sql, res)
        return
      }

      default:
        sendJson(res, 404, { error: `Unknown endpoint ${url.pathname}` })
    }
  } finally {
    db.close()
  }
}

/**
 * Run `toklume sync` on demand from the dashboard's sync button.
 *
 * This is the only endpoint that opens a writable handle. It reuses the same
 * `runSync` path as the CLI command, so a browser-triggered sync behaves
 * identically to running `toklume sync` yourself.
 */
function handleSync(req: IncomingMessage, res: ServerResponse, dbPath: string | undefined): void {
  // No request body is expected; draining it lets the connection close cleanly.
  req.resume()
  req.on('end', () => {
    let db: Db
    try {
      db = openDb({ dbPath })
    } catch (err) {
      sendJson(res, 503, { error: errorMessage(err) })
      return
    }

    try {
      const result = runSync(db)
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 500, { error: errorMessage(err) })
    } finally {
      db.close()
    }
  })
}

/**
 * Execute a user-supplied query from the browser SQL console.
 *
 * The connection is read-only, so mutations are rejected by SQLite itself —
 * this is the same guarantee `toklume query` relies on, not a string filter.
 * Row count is capped so a careless `SELECT *` cannot exhaust memory.
 */
function runUserQuery(db: Db, sql: string, res: ServerResponse): void {
  const MAX_ROWS = 1000
  try {
    const statement = db.prepare(sql)
    if (!statement.reader) {
      statement.run()
      sendJson(res, 200, { rows: [], columns: [], truncated: false })
      return
    }

    const rows = statement.all() as Record<string, unknown>[]
    const truncated = rows.length > MAX_ROWS
    const limited = truncated ? rows.slice(0, MAX_ROWS) : rows
    // columns() reports the result-set shape even when no rows came back,
    // and preserves declared order that Object.keys on a row would lose.
    const columns = statement.columns().map((c) => c.name)

    sendJson(res, 200, { rows: limited, columns, truncated, totalRows: rows.length })
  } catch (err) {
    sendJson(res, 400, { error: errorMessage(err) })
  }
}

function serveStatic(pathname: string, res: ServerResponse, assetDir: string | null): void {
  if (!assetDir) {
    sendHtml(res, 200, missingBuildPage())
    return
  }

  const requested = pathname === '/' ? '/index.html' : pathname
  // normalize + prefix check keeps '../' traversal out of the asset dir.
  const resolved = join(assetDir, normalize(requested))
  const safe = resolved.startsWith(assetDir) && existsSync(resolved) && statSync(resolved).isFile()

  // Unknown paths fall through to index.html so client-side routing works.
  const file = safe ? resolved : join(assetDir, 'index.html')
  if (!existsSync(file)) {
    sendHtml(res, 200, missingBuildPage())
    return
  }

  const type = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(readFileSync(file))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function missingBuildPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>toklume</title>
<style>
 body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#111}
 code{background:#f3f3f3;padding:.15em .4em;border-radius:4px}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}}
</style></head>
<body>
 <h1>Dashboard not built</h1>
 <p>The API is running, but the dashboard bundle was not found.</p>
 <p>Build it once with:</p>
 <p><code>pnpm --dir web install &amp;&amp; pnpm --dir web build</code></p>
 <p>The JSON API is available now at
 <code>/api/daily</code>, <code>/api/sessions</code>, <code>/api/meta</code> and
 <code>/api/query?sql=...</code>.</p>
</body></html>`
}
