import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../src/db/index.js'
import { Writer } from '../../src/db/queries.js'
import { scanFile } from '../../src/core/scan.js'
import type { Parser, ParseResult } from '../../src/parsers/types.js'

/**
 * Minimal parser: each line is `<key> <tokens>`. Lines starting with '!' are
 * treated as malformed. Keeps the test focused on scanning, not parsing.
 */
const fakeParser: Parser = {
  id: 'claude_code',
  displayName: 'Fake',
  detectRoots: () => [],
  listFiles: () => [],
  parseLines(lines, sourceFile): ParseResult {
    const events = []
    let skipped = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (trimmed.startsWith('!')) {
        skipped += 1
        continue
      }
      const [key, tokens] = trimmed.split(' ')
      events.push({
        dedupeKey: `fake:${key}`,
        tool: 'claude_code' as const,
        sessionId: 's1',
        model: 'test-model',
        ts: 1_700_000_000,
        inputTokens: Number(tokens ?? 0),
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        isCumulative: false,
        isSidechain: false,
        sourceFile,
      })
    }
    return { events, skipped }
  },
}

let dir: string
let db: Db
let writer: Writer
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toklume-scan-'))
  db = openDb({ dbPath: join(dir, 'usage.db') })
  writer = new Writer(db)
  file = join(dir, 'session.jsonl')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })

})

/**
 * Bump mtime so size-and-mtime equality checks see a real change.
 *
 * Uses whole seconds so the stored value is exact on every filesystem — a
 * sub-millisecond mtime can round differently between write and stat.
 */
function touchForward(path: string, secondsAhead: number): void {
  const t = new Date((Math.floor(Date.now() / 1000) + secondsAhead) * 1000)
  utimesSync(path, t, t)
}

describe('incremental scan', () => {
  it('parses only newly appended lines on a second sync', () => {
    writeFileSync(file, 'a 10\nb 20\n')
    const first = scanFile(fakeParser, writer, file)
    expect(first.status).toBe('scanned')
    expect(first.inserted).toBe(2)

    appendFileSync(file, 'c 30\n')
    touchForward(file, 1)

    const second = scanFile(fakeParser, writer, file)
    expect(second.status).toBe('scanned')
    // Only the appended line was handed to the parser.
    expect(second.inserted).toBe(1)
    expect(second.duplicates).toBe(0)

    expect(writer.eventCount()).toBe(3)
  })

  it('skips an unchanged file without reading its contents', () => {
    // Pin the mtime to a whole second so restoring it below is exact. Writing
    // and then calling utimesSync within the same millisecond can otherwise
    // round to a different stored value, making the file look changed.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)

    writeFileSync(file, 'a 10\n')
    utimesSync(file, pinned, pinned)
    const first = scanFile(fakeParser, writer, file)
    expect(first.inserted).toBe(1)

    const { size, mtimeMs } = statSync(file)

    // Swap in different content of the SAME byte length, then restore the
    // original mtime. Size and mtime are unchanged, so a scanner that honours
    // scan_state must not open the file — if it did, it would ingest 'z 99'.
    writeFileSync(file, 'z 99\n')
    utimesSync(file, pinned, pinned)

    const after = statSync(file)
    expect(after.size).toBe(size)
    expect(after.mtimeMs).toBe(mtimeMs) // precondition: the file looks untouched

    const result = scanFile(fakeParser, writer, file)

    expect(result.status).toBe('skipped')
    expect(result.inserted).toBe(0)
    expect(writer.eventCount()).toBe(1)
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM events WHERE dedupe_key = 'fake:z'").get()!.n,
    ).toBe(0)
  })

  it('does not consume a partial trailing line until it is complete', () => {
    writeFileSync(file, 'a 10\nb 2') // 'b 2' has no newline yet
    const first = scanFile(fakeParser, writer, file)

    expect(first.inserted).toBe(1) // only 'a 10'
    const stateAfterFirst = writer.getScanState(file)!
    expect(stateAfterFirst.byte_offset).toBe(Buffer.byteLength('a 10\n'))

    // Writer finishes the line.
    appendFileSync(file, '0\n')
    touchForward(file, 1)

    const second = scanFile(fakeParser, writer, file)
    expect(second.inserted).toBe(1) // now 'b 20'

    const rows = db
      .prepare<[], { dedupe_key: string; input_tokens: number }>(
        'SELECT dedupe_key, input_tokens FROM events ORDER BY dedupe_key',
      )
      .all()
    expect(rows).toEqual([
      { dedupe_key: 'fake:a', input_tokens: 10 },
      { dedupe_key: 'fake:b', input_tokens: 20 },
    ])
  })

  it('re-reads from zero when the file is truncated, and dedupe keeps totals correct', () => {
    writeFileSync(file, 'a 10\nb 20\nc 30\n')
    scanFile(fakeParser, writer, file)
    expect(writer.eventCount()).toBe(3)

    // Replace with a shorter file that repeats earlier content plus one new line.
    writeFileSync(file, 'a 10\nd 40\n')
    touchForward(file, 1)

    const result = scanFile(fakeParser, writer, file)
    expect(result.status).toBe('scanned')
    // Both lines were re-read; 'a' collapses via dedupe, 'd' is new.
    expect(result.inserted).toBe(1)
    expect(result.duplicates).toBe(1)
    expect(writer.getScanState(file)!.byte_offset).toBe(Buffer.byteLength('a 10\nd 40\n'))

    // a, b, c from before plus d — no double counting.
    expect(writer.eventCount()).toBe(4)
    const total = db
      .prepare<[], { t: number }>('SELECT SUM(input_tokens) AS t FROM events')
      .get()!.t
    expect(total).toBe(100)
  })

  it('re-reads from zero when mtime moves backwards (file replaced)', () => {
    writeFileSync(file, 'a 10\nb 20\n')
    scanFile(fakeParser, writer, file)

    // Same size, older mtime: a restored/rotated file.
    writeFileSync(file, 'x 11\ny 22\n')
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)

    const result = scanFile(fakeParser, writer, file)
    expect(result.inserted).toBe(2)
    expect(writer.eventCount()).toBe(4)
  })

  it('counts malformed lines without failing the file', () => {
    writeFileSync(file, 'a 10\n!bad\nb 20\n')
    const result = scanFile(fakeParser, writer, file)

    expect(result.status).toBe('scanned')
    expect(result.inserted).toBe(2)
    expect(result.malformed).toBe(1)
  })

  it('does not advance the offset when parsing throws', () => {
    writeFileSync(file, 'a 10\n')
    const throwing: Parser = {
      ...fakeParser,
      parseLines() {
        throw new Error('boom')
      },
    }

    const result = scanFile(throwing, writer, file)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('boom')
    expect(writer.getScanState(file)).toBeUndefined()

    // A later healthy scan picks the same bytes back up.
    const retry = scanFile(fakeParser, writer, file)
    expect(retry.inserted).toBe(1)
  })

  it('reports a missing file as failed rather than throwing', () => {
    const result = scanFile(fakeParser, writer, join(dir, 'nope.jsonl'))
    expect(result.status).toBe('failed')
  })
})
