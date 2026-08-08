import Table from 'cli-table3'
import pc from 'picocolors'

/** Thousands-separated integer, or '0'. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Format an estimated cost. Unknown pricing renders as an em dash — never as
 * 0, which would read as "this was free".
 */
export function formatCost(cost: number | null): string {
  if (cost === null) return pc.dim('—')
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

/** Local date+time for table display. */
export function formatTs(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Shorten a session id so it fits a terminal column. */
export function shortSessionId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-3)}`
}

export interface TableOptions {
  head: string[]
  /** Column indexes to right-align (numeric columns). */
  rightAlign?: number[]
}

export function renderTable(options: TableOptions, rows: string[][]): string {
  const align = new Set(options.rightAlign ?? [])
  const table = new Table({
    head: options.head.map((h) => pc.bold(h)),
    style: { head: [], border: [] },
    colAligns: options.head.map((_, i) => (align.has(i) ? 'right' : 'left')),
  })
  for (const row of rows) table.push(row)
  return table.toString()
}

export function printLine(text = ''): void {
  process.stdout.write(`${text}\n`)
}

