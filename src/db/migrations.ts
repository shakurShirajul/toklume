/**
 * Migrations are inlined SQL strings so the bundle never needs to ship .sql
 * assets. Each entry runs inside its own transaction; the runner applies them
 * in ascending `version` order and records progress in `schema_version`.
 *
 * Never edit an applied migration — add a new one.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

const M001_INITIAL = `
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  dedupe_key         TEXT    NOT NULL UNIQUE,
  tool               TEXT    NOT NULL,
  session_id         TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  ts                 INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  is_cumulative      INTEGER NOT NULL DEFAULT 0,
  is_sidechain       INTEGER NOT NULL DEFAULT 0,
  project            TEXT,
  source_file        TEXT    NOT NULL
);

CREATE INDEX idx_events_ts      ON events (ts);
CREATE INDEX idx_events_session ON events (tool, session_id);

CREATE TABLE scan_state (
  source_file TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  scanned_at  INTEGER NOT NULL
);

CREATE VIEW turn_usage AS
SELECT
  id, tool, session_id, model, ts, project, is_sidechain,
  CASE WHEN is_cumulative = 0 THEN input_tokens
       ELSE MAX(input_tokens - LAG(input_tokens, 1, 0)
            OVER (PARTITION BY tool, session_id ORDER BY ts, id), 0) END AS input_tokens,
  CASE WHEN is_cumulative = 0 THEN output_tokens
       ELSE MAX(output_tokens - LAG(output_tokens, 1, 0)
            OVER (PARTITION BY tool, session_id ORDER BY ts, id), 0) END AS output_tokens,
  CASE WHEN is_cumulative = 0 THEN cache_write_tokens
       ELSE MAX(cache_write_tokens - LAG(cache_write_tokens, 1, 0)
            OVER (PARTITION BY tool, session_id ORDER BY ts, id), 0) END AS cache_write_tokens,
  CASE WHEN is_cumulative = 0 THEN cache_read_tokens
       ELSE MAX(cache_read_tokens - LAG(cache_read_tokens, 1, 0)
            OVER (PARTITION BY tool, session_id ORDER BY ts, id), 0) END AS cache_read_tokens,
  CASE WHEN is_cumulative = 0 THEN reasoning_tokens
       ELSE MAX(reasoning_tokens - LAG(reasoning_tokens, 1, 0)
            OVER (PARTITION BY tool, session_id ORDER BY ts, id), 0) END AS reasoning_tokens
FROM events;
`

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', sql: M001_INITIAL },
]
