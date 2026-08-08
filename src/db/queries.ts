import type { Db } from './index.js'
import type { NormalizedEvent } from '../parsers/types.js'

export interface ScanStateRow {
  source_file: string
  size: number
  mtime: number
  byte_offset: number
  scanned_at: number
}

/**
 * The only write path into the database.
 *
 * Parsers produce NormalizedEvent[]; this module persists them. Keeping writes
 * here means a parser can never accidentally couple itself to the schema.
 */
export class Writer {
  private readonly insertEvent
  private readonly upsertScanState
  private readonly selectScanState
  private readonly countEvents

  constructor(private readonly db: Db) {
    // INSERT OR IGNORE: re-scanning an already-ingested line is a no-op thanks
    // to the UNIQUE constraint on dedupe_key.
    this.insertEvent = db.prepare(`
      INSERT OR IGNORE INTO events (
        dedupe_key, tool, session_id, model, ts,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, reasoning_tokens,
        is_cumulative, is_sidechain, project, source_file
      ) VALUES (
        @dedupeKey, @tool, @sessionId, @model, @ts,
        @inputTokens, @outputTokens, @cacheWriteTokens, @cacheReadTokens, @reasoningTokens,
        @isCumulative, @isSidechain, @project, @sourceFile
      )
    `)

    this.upsertScanState = db.prepare(`
      INSERT INTO scan_state (source_file, size, mtime, byte_offset, scanned_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_file) DO UPDATE SET
        size = excluded.size,
        mtime = excluded.mtime,
        byte_offset = excluded.byte_offset,
        scanned_at = excluded.scanned_at
    `)

    this.selectScanState = db.prepare<[string], ScanStateRow>(
      'SELECT * FROM scan_state WHERE source_file = ?',
    )

    this.countEvents = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM events')
  }

  getScanState(sourceFile: string): ScanStateRow | undefined {
    return this.selectScanState.get(sourceFile)
  }

  eventCount(): number {
    return this.countEvents.get()?.n ?? 0
  }

  /**
   * Insert a batch of events and advance scan state for one file, atomically.
   *
   * Returns how many rows were newly inserted vs. ignored as duplicates. If the
   * transaction throws, neither the events nor the offset advance — the file is
   * re-read from the same offset on the next sync.
   */
  commitFile(
    events: NormalizedEvent[],
    state: { sourceFile: string; size: number; mtime: number; byteOffset: number },
  ): { inserted: number; duplicates: number } {
    const run = this.db.transaction(() => {
      let inserted = 0
      for (const event of events) {
        const info = this.insertEvent.run({
          dedupeKey: event.dedupeKey,
          tool: event.tool,
          sessionId: event.sessionId,
          model: event.model,
          ts: event.ts,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          cacheReadTokens: event.cacheReadTokens,
          reasoningTokens: event.reasoningTokens,
          isCumulative: event.isCumulative ? 1 : 0,
          isSidechain: event.isSidechain ? 1 : 0,
          project: event.project ?? null,
          sourceFile: event.sourceFile,
        })
        if (info.changes > 0) inserted += 1
      }

      this.upsertScanState.run(
        state.sourceFile,
        state.size,
        state.mtime,
        state.byteOffset,
        Math.floor(Date.now() / 1000),
      )

      return { inserted, duplicates: events.length - inserted }
    })

    return run()
  }
}

/** Total ingested events. */
export function eventCount(db: Db): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0
}

/** Most recent scan timestamp across all files, or null if never synced. */
export function lastSyncAt(db: Db): number | null {
  const row = db
    .prepare<[], { t: number | null }>('SELECT MAX(scanned_at) AS t FROM scan_state')
    .get()
  return row?.t ?? null
}

/** Distinct model names recorded for a tool — used by doctor to flag unknowns. */
export function distinctModels(db: Db, tool?: string): string[] {
  const rows = tool
    ? db
        .prepare<[string], { model: string }>(
          'SELECT DISTINCT model FROM events WHERE tool = ? ORDER BY model',
        )
        .all(tool)
    : db
        .prepare<[], { model: string }>('SELECT DISTINCT model FROM events ORDER BY model')
        .all()
  return rows.map((r) => r.model)
}

/** Number of scan_state rows recorded for files under the given tool's roots. */
export function scannedFileCount(db: Db, roots: string[]): number {
  if (roots.length === 0) return 0
  const clauses = roots.map(() => 'source_file LIKE ?').join(' OR ')
  const params = roots.map((r) => `${r}%`)
  const row = db
    .prepare<string[], { n: number }>(`SELECT COUNT(*) AS n FROM scan_state WHERE ${clauses}`)
    .get(...params)
  return row?.n ?? 0
}
