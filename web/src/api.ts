/**
 * Typed client for the local toklume API.
 *
 * Every request is same-origin against `toklume web`, which serves this bundle.
 * The dashboard never contacts anything else.
 */

export interface DailyRow {
  date: string
  tool: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number | null
}

export interface DailyReport {
  rows: DailyRow[]
  totals: DailyRow
  unknownModels: string[]
  caption: string
}

export interface SessionRow {
  sessionId: string
  tool: string
  project: string | null
  firstTs: number
  lastTs: number
  turns: number
  sidechainTurns: number
  models: string[]
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number | null
}

export interface SessionsReport {
  rows: SessionRow[]
  unknownModels: string[]
  caption: string
}

export interface ToolStatus {
  id: string
  displayName: string
  detected: boolean
  unsupported: string | null
}

export interface Meta {
  events: number
  lastSyncAt: number | null
  pricingUpdated: string
  models: string[]
  tools: ToolStatus[]
  caption: string
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  columns: string[]
  truncated: boolean
  totalRows?: number
}

// Mirrors ToolSyncResult/SyncResult in ../../src/core/sync.ts. Not imported
// directly: the web/ package builds independently of the CLI/server package,
// and that module pulls in Node-only dependencies. Keep the two in sync by hand.
export interface ToolSyncResult {
  tool: string
  detected: boolean
  skipped: boolean
  reason?: string
  filesScanned?: number
  filesSkipped?: number
  newEvents?: number
  duplicatesIgnored?: number
  malformedLines?: number
  failures?: { sourceFile: string; error: string }[]
}

export interface SyncResult {
  elapsedMs: number
  tools: ToolSyncResult[]
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST' })
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

export function fetchMeta(): Promise<Meta> {
  return get<Meta>('/api/meta')
}

export function fetchDaily(params: { since?: string; until?: string; tool?: string }): Promise<DailyReport> {
  const search = new URLSearchParams()
  if (params.since) search.set('since', params.since)
  if (params.until) search.set('until', params.until)
  if (params.tool) search.set('tool', params.tool)
  const qs = search.toString()
  return get<DailyReport>(`/api/daily${qs ? `?${qs}` : ''}`)
}

export function fetchSessions(params: { tool?: string; limit?: number }): Promise<SessionsReport> {
  const search = new URLSearchParams()
  if (params.tool) search.set('tool', params.tool)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return get<SessionsReport>(`/api/sessions${qs ? `?${qs}` : ''}`)
}

export function runQuery(sql: string): Promise<QueryResult> {
  return get<QueryResult>(`/api/query?sql=${encodeURIComponent(sql)}`)
}

export function triggerSync(): Promise<SyncResult> {
  return post<SyncResult>('/api/sync')
}

/* Formatting helpers ------------------------------------------------------ */

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** Compact form for dense table cells. */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

/**
 * Unknown pricing renders as an em dash — never as $0.
 *
 * `approx` marks a total that mixes priced and unpriced rows: the number is
 * a floor, not the real total, so it renders as "≥ $x.xx" rather than a
 * bare dollar figure that looks exact.
 */
export function formatCost(cost: number | null, approx = false): string {
  if (cost === null) return '—'
  const s = cost === 0 ? '$0.00' : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
  return approx ? `≥ ${s}` : s
}

export function formatTs(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function shortSessionId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-3)}`
}
