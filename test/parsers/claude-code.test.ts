import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeCodeParser } from '../../src/parsers/claude-code/index.js'
import { claudeDedupeKey } from '../../src/parsers/claude-code/dedupe.js'
import { hash128 } from '../../src/parsers/shared.js'
import { openDb, type Db } from '../../src/db/index.js'
import { Writer } from '../../src/db/queries.js'
import { sessionsReport } from '../../src/reports/sessions.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/claude-code/', import.meta.url))

function linesOf(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.length > 0)
}

function parse(name: string) {
  return claudeCodeParser.parseLines(linesOf(name), join(FIXTURES, name), { fileMtime: 1_700_000_000 })
}

let dir: string
let db: Db
let writer: Writer

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toklume-cc-'))
  db = openDb({ dbPath: join(dir, 'usage.db') })
  writer = new Writer(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('claude code parser — normal.jsonl', () => {
  it('extracts tokens, model, session and timestamps', () => {
    const { events, skipped } = parse('normal.jsonl')

    expect(skipped).toBe(0)
    expect(events).toHaveLength(3)

    const first = events[0]!
    expect(first.tool).toBe('claude_code')
    expect(first.sessionId).toBe('sess-normal')
    expect(first.model).toBe('claude-opus-5')
    expect(first.inputTokens).toBe(12)
    expect(first.outputTokens).toBe(250)
    expect(first.cacheWriteTokens).toBe(1500)
    expect(first.cacheReadTokens).toBe(8000)
    expect(first.isCumulative).toBe(false)
    expect(first.isSidechain).toBe(false)
    expect(first.project).toBe('/home/dev/proj')
    // 2026-01-15T10:00:05Z
    expect(first.ts).toBe(Math.floor(Date.parse('2026-01-15T10:00:05.000Z') / 1000))

    expect(events[2]!.model).toBe('claude-sonnet-5')
  })

  it('builds dedupe keys from message id and request id', () => {
    const { events } = parse('normal.jsonl')
    expect(events[0]!.dedupeKey).toBe('cc:msg_001:req_A1')
  })

  it('ignores non-assistant entries rather than counting them as malformed', () => {
    const { events, skipped } = parse('normal.jsonl')
    // Two 'user' lines are ignored, not skipped.
    expect(skipped).toBe(0)
    expect(events).toHaveLength(3)
  })
})

describe('claude code parser — malformed.jsonl', () => {
  it('parses good lines, skips bad ones, and never throws', () => {
    const result = parse('malformed.jsonl')

    // Two bad lines: raw text, and a truncated JSON object.
    expect(result.skipped).toBe(2)
    // Two usable events; the no-usage line and the summary line are ignored.
    expect(result.events).toHaveLength(2)
    expect(result.events.map((e) => e.dedupeKey)).toEqual([
      'cc:msg_ok1:req_M1',
      'cc:msg_ok2:req_M3',
    ])
  })

  it('defaults missing usage fields to zero', () => {
    const { events } = parse('malformed.jsonl')
    const partial = events[1]!
    expect(partial.outputTokens).toBe(75)
    expect(partial.inputTokens).toBe(0)
    expect(partial.cacheWriteTokens).toBe(0)
    expect(partial.cacheReadTokens).toBe(0)
  })

  it('falls back to file mtime when a timestamp is absent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_nots', model: 'claude-opus-5', usage: { output_tokens: 5 } },
    })
    const { events } = claudeCodeParser.parseLines([line], '/tmp/x/sess-abc.jsonl', {
      fileMtime: 1_700_000_000,
    })
    expect(events[0]!.ts).toBe(1_700_000_000)
  })

  it('falls back to the filename stem when sessionId is absent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_nosess', model: 'claude-opus-5', usage: { output_tokens: 5 } },
    })
    const { events } = claudeCodeParser.parseLines([line], join('/tmp/proj', 'sess-abc.jsonl'))
    expect(events[0]!.sessionId).toBe('sess-abc')
  })
})

describe('claude code parser — sidechain.jsonl', () => {
  it('ingests sidechain turns with is_sidechain set rather than dropping them', () => {
    const { events } = parse('sidechain.jsonl')

    expect(events).toHaveLength(4)
    expect(events.map((e) => e.isSidechain)).toEqual([false, true, true, false])
  })

  it('attributes sidechain tokens to the parent session in the sessions report', () => {
    const { events } = parse('sidechain.jsonl')
    writer.commitFile(events, {
      sourceFile: join(FIXTURES, 'sidechain.jsonl'),
      size: 1,
      mtime: 1,
      byteOffset: 1,
    })

    const rows = sessionsReport(db, {}).rows
    expect(rows).toHaveLength(1)

    const session = rows[0]!
    expect(session.sessionId).toBe('sess-side')
    // All four turns roll into the one session: 10+4+6+20 input.
    expect(session.inputTokens).toBe(40)
    expect(session.outputTokens).toBe(350)
    expect(session.cacheWriteTokens).toBe(700)
    expect(session.cacheReadTokens).toBe(4100)
    expect(session.turns).toBe(4)
    // Sidechain turns are counted but reported separately for transparency.
    expect(session.sidechainTurns).toBe(2)
  })
})

describe('claude code parser — resumed sessions', () => {
  it('ignores duplicate messages replayed into a continued session file', () => {
    const original = parse('resumed.jsonl')
    const continued = parse('resumed-continued.jsonl')

    // The resumed file replays both original messages under a NEW session id.
    // Content-derived keys must still collapse them.
    expect(original.events.map((e) => e.dedupeKey)).toEqual([
      'cc:msg_r001:req_R1',
      'cc:msg_r002:req_R2',
    ])
    expect(continued.events.slice(0, 2).map((e) => e.dedupeKey)).toEqual([
      'cc:msg_r001:req_R1',
      'cc:msg_r002:req_R2',
    ])

    const firstCommit = writer.commitFile(original.events, {
      sourceFile: join(FIXTURES, 'resumed.jsonl'),
      size: 1,
      mtime: 1,
      byteOffset: 1,
    })
    expect(firstCommit.inserted).toBe(2)

    const totalAfterFirst = db
      .prepare<[], { t: number }>('SELECT SUM(input_tokens + output_tokens) AS t FROM events')
      .get()!.t

    const secondCommit = writer.commitFile(continued.events, {
      sourceFile: join(FIXTURES, 'resumed-continued.jsonl'),
      size: 1,
      mtime: 1,
      byteOffset: 1,
    })

    // Only the genuinely new third message is inserted.
    expect(secondCommit.inserted).toBe(1)
    expect(secondCommit.duplicates).toBe(2)
    expect(writer.eventCount()).toBe(3)

    const totalAfterSecond = db
      .prepare<[], { t: number }>('SELECT SUM(input_tokens + output_tokens) AS t FROM events')
      .get()!.t
    // Totals grew by exactly the new message, not by the replayed ones.
    expect(totalAfterSecond).toBe(totalAfterFirst + 30 + 260)
  })
})

describe('dedupe key construction', () => {
  it('uses message id alone when requestId is missing', () => {
    expect(claudeDedupeKey('msg_1', undefined, '/f.jsonl', 'raw')).toBe('cc:msg_1')
  })

  it('falls back to a content hash when message id is missing', () => {
    const key = claudeDedupeKey(undefined, undefined, '/f.jsonl', 'raw line')
    expect(key.startsWith('cc:')).toBe(true)
    expect(key.length).toBeGreaterThan(20)
  })

  it('produces different hashes for different content', () => {
    expect(hash128('alpha')).not.toBe(hash128('beta'))
    expect(hash128('alpha')).toBe(hash128('alpha'))
  })

  it('avoids collisions across a large body of realistic lines', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) {
      seen.add(hash128(`{"uuid":"u-${i}","tokens":${i * 7}}`))
    }
    expect(seen.size).toBe(20_000)
  })
})

describe('log file discovery', () => {
  it('finds nested subagent transcripts, not just top-level session files', () => {
    // Real layout: <root>/<encoded-project>/<session-id>.jsonl plus
    // <root>/<encoded-project>/<session-id>/subagents/agent-*.jsonl
    const root = join(dir, 'projects')
    const project = join(root, '-home-dev-proj')
    const subagents = join(project, 'sess-1', 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(project, 'sess-1.jsonl'), '')
    writeFileSync(join(subagents, 'agent-abc.jsonl'), '')
    writeFileSync(join(project, 'notes.txt'), 'ignored')

    const files = claudeCodeParser.listFiles([root])

    expect(files).toHaveLength(2)
    expect(files.some((f) => f.endsWith('sess-1.jsonl'))).toBe(true)
    expect(files.some((f) => f.endsWith(join('subagents', 'agent-abc.jsonl')))).toBe(true)
  })

  it('decodes the project from the encoded directory even for nested files', () => {
    const nested = join(
      '/home/u/.claude/projects',
      '-home-dev-proj',
      'sess-1',
      'subagents',
      'agent-abc.jsonl',
    )
    // No cwd on the entry, so the directory-derived fallback is used.
    const line = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { id: 'msg_sub', model: 'claude-opus-5', usage: { output_tokens: 7 } },
    })
    const { events } = claudeCodeParser.parseLines([line], nested)

    expect(events[0]!.isSidechain).toBe(true)
    expect(events[0]!.project).toBe('/home/dev/proj')
  })
})

describe('parser robustness', () => {
  it('never throws on adversarial input', () => {
    const nasty = [
      '',
      '   ',
      'null',
      '[]',
      '"a string"',
      '123',
      '{"type":"assistant"}',
      '{"type":"assistant","message":null}',
      '{"type":"assistant","message":{"usage":null}}',
      '{"type":"assistant","message":{"usage":{"input_tokens":"abc"}}}',
      '{"type":"assistant","message":{"usage":{"input_tokens":-5,"output_tokens":1.7}}}',
      '{',
    ]
    expect(() => claudeCodeParser.parseLines(nasty, '/tmp/p/s.jsonl')).not.toThrow()

    const { events } = claudeCodeParser.parseLines(nasty, '/tmp/p/s.jsonl')
    // The two usage-bearing lines yield events with sanitized counts.
    const counts = events.map((e) => [e.inputTokens, e.outputTokens])
    expect(counts).toEqual([
      [0, 0],
      [0, 1],
    ])
  })
})
