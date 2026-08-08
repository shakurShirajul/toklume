import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexParser } from '../../src/parsers/codex/index.js'
import { openDb, type Db } from '../../src/db/index.js'
import { Writer } from '../../src/db/queries.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/codex/', import.meta.url))

interface TurnRow {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
}

function linesOf(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.length > 0)
}

function parse(name: string) {
  return codexParser.parseLines(linesOf(name), join(FIXTURES, name), { fileMtime: 1_700_000_000 })
}

let dir: string
let db: Db
let writer: Writer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toklume-codex-'))
  db = openDb({ dbPath: join(dir, 'usage.db') })
  writer = new Writer(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(name: string): void {
  const { events } = parse(name)
  writer.commitFile(events, { sourceFile: join(FIXTURES, name), size: 1, mtime: 1, byteOffset: 1 })
}

function turnRows(): TurnRow[] {
  return db
    .prepare<[], TurnRow>(
      `SELECT input_tokens, output_tokens, cache_read_tokens, reasoning_tokens
       FROM turn_usage ORDER BY ts, id`,
    )
    .all()
}

describe('codex parser — cumulative.jsonl', () => {
  it('stores raw running totals flagged as cumulative', () => {
    const { events, skipped } = parse('cumulative.jsonl')

    expect(skipped).toBe(0)
    // Three usage-bearing lines; the info:null rate-limit update is ignored.
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.isCumulative)).toBe(true)
    expect(events.every((e) => e.tool === 'codex')).toBe(true)
  })

  it('picks up the model from turn_context and the session id from session_meta', () => {
    const { events } = parse('cumulative.jsonl')
    expect(events[0]!.model).toBe('gpt-5-codex')
    expect(events[0]!.sessionId).toBe('01960000-aaaa-7000-8000-000000000001')
    expect(events[0]!.project).toBe('/home/dev/codexproj')
  })

  it('separates cached input from fresh input so cache reads are not double counted', () => {
    const { events } = parse('cumulative.jsonl')
    // Raw totals: input 1000 inclusive of 200 cached -> 800 fresh + 200 cached.
    expect(events[0]!.inputTokens).toBe(800)
    expect(events[0]!.cacheReadTokens).toBe(200)
  })

  it('derives per-turn deltas through turn_usage that match hand-computed values', () => {
    ingest('cumulative.jsonl')

    // Raw cumulative fresh-input: 800, 1800, 2800 -> deltas 800, 1000, 1000
    // Raw cumulative cached:      200,  700, 1200 -> deltas 200,  500,  500
    // Raw cumulative output:      100,  260,  400 -> deltas 100,  160,  140
    // Raw cumulative reasoning:    40,   90,  150 -> deltas  40,   50,   60
    expect(turnRows()).toEqual([
      { input_tokens: 800, output_tokens: 100, cache_read_tokens: 200, reasoning_tokens: 40 },
      { input_tokens: 1000, output_tokens: 160, cache_read_tokens: 500, reasoning_tokens: 50 },
      { input_tokens: 1000, output_tokens: 140, cache_read_tokens: 500, reasoning_tokens: 60 },
    ])
  })

  it('sums deltas back to the final running total', () => {
    ingest('cumulative.jsonl')
    const summed = db
      .prepare<[], { input: number; output: number; cached: number }>(
        `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_read_tokens) AS cached FROM turn_usage`,
      )
      .get()!
    // The last cumulative reading is the session total.
    expect(summed.input).toBe(2800)
    expect(summed.output).toBe(400)
    expect(summed.cached).toBe(1200)
  })
})

describe('codex parser — session_reset.jsonl', () => {
  it('clamps counter resets to zero instead of producing negative deltas', () => {
    ingest('session_reset.jsonl')
    const rows = turnRows()

    // Fresh input cumulative: 4000, 7000, 700, 1800
    //   deltas: 4000, 3000, (700-7000 -> clamped 0), 1100
    expect(rows.map((r) => r.input_tokens)).toEqual([4000, 3000, 0, 1100])
    expect(rows.map((r) => r.output_tokens)).toEqual([500, 400, 0, 120])
    expect(rows.map((r) => r.reasoning_tokens)).toEqual([200, 150, 0, 50])

    for (const row of rows) {
      expect(row.input_tokens).toBeGreaterThanOrEqual(0)
      expect(row.output_tokens).toBeGreaterThanOrEqual(0)
      expect(row.cache_read_tokens).toBeGreaterThanOrEqual(0)
      expect(row.reasoning_tokens).toBeGreaterThanOrEqual(0)
    }
  })

  it('never lets totals decrease as turns accumulate', () => {
    ingest('session_reset.jsonl')
    const rows = turnRows()

    let running = 0
    for (const row of rows) {
      const next = running + row.input_tokens + row.output_tokens
      expect(next).toBeGreaterThanOrEqual(running)
      running = next
    }
    expect(running).toBeGreaterThan(0)
  })
})

describe('codex parser — dedupe and robustness', () => {
  it('produces stable keys so re-parsing the same file inserts nothing new', () => {
    ingest('cumulative.jsonl')
    expect(writer.eventCount()).toBe(3)

    // Simulate an offset reset: the whole file is handed over again.
    const { events } = parse('cumulative.jsonl')
    const second = writer.commitFile(events, {
      sourceFile: join(FIXTURES, 'cumulative.jsonl'),
      size: 1,
      mtime: 1,
      byteOffset: 1,
    })

    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)
    expect(writer.eventCount()).toBe(3)
  })

  it('includes a content hash so a changed line at the same sequence is distinct', () => {
    const { events } = parse('cumulative.jsonl')
    const keys = events.map((e) => e.dedupeKey)
    expect(new Set(keys).size).toBe(3)
    for (const key of keys) {
      expect(key).toMatch(/^codex:[0-9a-f-]+:\d+:[0-9a-f]{8}$/)
    }
  })

  it('skips malformed lines without throwing', () => {
    const lines = [
      '{"type":"session_meta","payload":{"id":"s-1"}}',
      'not json',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{',
      '{"type":"event_msg","payload":{"type":"token_count","info":null}}',
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":2}}}}',
    ]
    expect(() => codexParser.parseLines(lines, '/tmp/c/s.jsonl')).not.toThrow()

    const { events, skipped } = codexParser.parseLines(lines, '/tmp/c/s.jsonl')
    expect(skipped).toBe(2)
    expect(events).toHaveLength(1)
    expect(events[0]!.inputTokens).toBe(10)
  })

  it('falls back to the filename stem when session_meta is absent', () => {
    const lines = [
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5,"output_tokens":1}}}}',
    ]
    const { events } = codexParser.parseLines(lines, join('/tmp/c', 'rollout-xyz.jsonl'))
    expect(events[0]!.sessionId).toBe('rollout-xyz')
  })
})

describe('mixed sources', () => {
  it('keeps per-message sources unaffected by the cumulative delta logic', () => {
    // A non-cumulative event must pass through turn_usage unchanged.
    writer.commitFile(
      [
        {
          dedupeKey: 'cc:mix1',
          tool: 'claude_code',
          sessionId: 'mixed',
          model: 'claude-opus-5',
          ts: 1_700_000_100,
          inputTokens: 111,
          outputTokens: 22,
          cacheWriteTokens: 3,
          cacheReadTokens: 4,
          reasoningTokens: 0,
          isCumulative: false,
          isSidechain: false,
          sourceFile: '/tmp/mixed.jsonl',
        },
        {
          dedupeKey: 'cc:mix2',
          tool: 'claude_code',
          sessionId: 'mixed',
          model: 'claude-opus-5',
          ts: 1_700_000_200,
          inputTokens: 222,
          outputTokens: 33,
          cacheWriteTokens: 5,
          cacheReadTokens: 6,
          reasoningTokens: 0,
          isCumulative: false,
          isSidechain: false,
          sourceFile: '/tmp/mixed.jsonl',
        },
      ],
      { sourceFile: '/tmp/mixed.jsonl', size: 1, mtime: 1, byteOffset: 1 },
    )

    const rows = db
      .prepare<[], { input_tokens: number }>(
        "SELECT input_tokens FROM turn_usage WHERE tool = 'claude_code' ORDER BY ts",
      )
      .all()
    // No differencing applied: values match what was stored.
    expect(rows.map((r) => r.input_tokens)).toEqual([111, 222])
  })
})
