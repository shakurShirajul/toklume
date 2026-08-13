import type { ReactNode } from 'react'

const KEYWORDS =
  /\b(?:SELECT|FROM|WHERE|GROUP|ORDER|BY|LIMIT|AS|SUM|COUNT|ROUND|NULLIF|DATE|STRFTIME|DESC|ASC|JOIN|ON|AND|OR|NOT|NULL|IS|HAVING|CASE|WHEN|THEN|ELSE|END|DISTINCT)\b/i
const WRITE_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|DROP|INTO|CREATE|ALTER)\b/i
const TOKEN = new RegExp(
  `(--[^\\n]*|'[^']*'|\\b\\d+(?:\\.\\d+)?\\b|${KEYWORDS.source}|${WRITE_KEYWORDS.source})`,
  'gi',
)

/** Splits SQL into highlighted spans for the read-only preview layer. */
export function highlightSql(sql: string): ReactNode[] {
  const parts = sql.split(TOKEN)
  return parts.map((part, i) => {
    if (!part) return null
    let className: string | null = null
    if (/^--/.test(part)) className = 'sql-comment'
    else if (/^'/.test(part)) className = 'sql-string'
    else if (/^\d/.test(part)) className = 'sql-number'
    else if (WRITE_KEYWORDS.test(part)) className = 'sql-write'
    else if (KEYWORDS.test(part)) className = 'sql-keyword'
    return className ? (
      <span key={i} className={className}>
        {part}
      </span>
    ) : (
      part
    )
  })
}
