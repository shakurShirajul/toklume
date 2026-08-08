# toklume

**A local SQLite database of your AI coding agent token usage — Claude Code, Codex, OpenCode. No daemon, no cloud, no account. Just a database you can query.**

Most usage tools give you a dashboard: someone else's idea of which five numbers matter, and no way to ask a sixth question. toklume inverts that. It reads the session logs your agents already write to disk, normalizes them into one SQLite file, and gets out of the way. The database *is* the product — `toklume daily` and `toklume sessions` are just two queries that ship in the box.

If you have ever wanted to know which project burned your context budget last month, whether your cache hit rate got worse after a config change, or what a subagent actually costs, that is a `SELECT` away.

```console
$ npx toklume sync && npx toklume daily
```

## Install

```bash
npm install -g toklume     # or: pnpm add -g toklume
toklume sync               # ingest your history
toklume daily              # see it
```

Requires Node >= 20. First sync reads your whole history; later syncs only read what changed.

## Commands

| Command | What it does |
| --- | --- |
| `toklume sync` | Scan agent logs, ingest new usage. Safe to re-run — already-ingested turns are ignored. |
| `toklume daily` | Tokens per day, per tool, with estimated cost. `--since` `--until` `--tool` `--json` |
| `toklume sessions` | Per-session rollup, newest first. `--tool` `--limit` `--json` |
| `toklume query "<SQL>"` | Read-only SQL against the database. The main event. |
| `toklume doctor` | What was detected, what synced, what is unpriced. Run this first when something looks wrong. |
| `toklume web` | Local dashboard on `127.0.0.1:4477`, including an in-browser SQL console. |

Every command takes `--db <path>` to point at a different database.

## The schema

This is the product surface, so it is documented rather than hidden.

### `events` — one row per usage-bearing turn, as parsed

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER | Primary key. |
| `dedupe_key` | TEXT | Unique. Content-derived, so re-scanning or resuming a session cannot double-count. |
| `tool` | TEXT | `claude_code`, `codex`, or `opencode`. |
| `session_id` | TEXT | The agent's own session id. Subagent turns carry their **parent's** id. |
| `model` | TEXT | Model id as the agent reported it. |
| `ts` | INTEGER | Unix seconds. |
| `input_tokens` | INTEGER | Fresh input, excluding cache reads. |
| `output_tokens` | INTEGER | Generated tokens. |
| `cache_write_tokens` | INTEGER | Tokens written to the prompt cache. |
| `cache_read_tokens` | INTEGER | Tokens served from cache — usually the largest number here, and the cheapest. |
| `reasoning_tokens` | INTEGER | Reasoning tokens where the tool reports them separately. |
| `is_cumulative` | INTEGER | `1` when the raw values are running totals (Codex). See `turn_usage`. |
| `is_sidechain` | INTEGER | `1` for subagent turns. Real usage — counted, never dropped. |
| `project` | TEXT | Working directory the session ran in, when known. |
| `source_file` | TEXT | Log file the row came from. |

### `turn_usage` — the view you usually want

Same columns as `events`, but token counts are **per-turn**. Sources that log running totals are differenced here with a window function and clamped at zero, so a counter reset on session resume cannot produce a negative. Both built-in reports read this view and never touch `events` directly. So should you, unless you specifically want raw values.

### `scan_state` — incremental scan bookkeeping

One row per log file: `source_file`, `size`, `mtime`, `byte_offset`, `scanned_at`. This is how a re-sync skips 99% of your files without opening them.

## Example queries

**Which projects cost the most?**

```bash
toklume query "
  SELECT project,
         SUM(input_tokens + output_tokens) AS tokens,
         COUNT(*) AS turns
  FROM turn_usage
  WHERE project IS NOT NULL
  GROUP BY project
  ORDER BY tokens DESC
  LIMIT 10"
```

**Is my cache hit rate improving?**

```bash
toklume query "
  SELECT DATE(ts,'unixepoch','localtime') AS day,
         ROUND(1.0 * SUM(cache_read_tokens) /
               NULLIF(SUM(cache_read_tokens + input_tokens), 0), 4) AS cache_ratio
  FROM turn_usage
  GROUP BY day
  ORDER BY day DESC
  LIMIT 21"
```

**Tokens by model, per week**

```bash
toklume query "
  SELECT STRFTIME('%Y-W%W', ts, 'unixepoch', 'localtime') AS week,
         model,
         SUM(input_tokens + output_tokens + reasoning_tokens) AS tokens
  FROM turn_usage
  GROUP BY week, model
  ORDER BY week DESC, tokens DESC"
```

**What do subagents actually cost me?**

```bash
toklume query "
  SELECT is_sidechain,
         COUNT(*) AS turns,
         SUM(output_tokens) AS output
  FROM turn_usage
  GROUP BY is_sidechain"
```

The connection is opened read-only, so `DELETE`, `UPDATE` and `DROP` are rejected by SQLite itself — you cannot corrupt your history with a typo.

## Supported tools

| Tool | Log location | Status |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl`, plus nested `subagents/` transcripts. Honors `$CLAUDE_CONFIG_DIR`. | Full support. Per-message usage. |
| **Codex CLI** | `~/.codex/sessions/**/*.jsonl`, or `$CODEX_HOME/sessions`. | Full support. Counters are running totals, differenced in `turn_usage`. |
| **OpenCode** | `~/.local/share/opencode`, `~/.opencode`, platform equivalents. | **Partial.** JSONL storage is parsed; SQLite-backed installs are detected and skipped. |

### The OpenCode limitation

OpenCode's storage backend changed between versions. When toklume finds a SQLite-backed install, it reports:

```
! opencode: OpenCode detected but format not yet supported (found: …/opencode.db)
```

and ingests nothing from it. That is deliberate: wrong numbers are worse than no numbers. `toklume doctor` always tells you which sources were skipped and why.

## Cost estimates

Rates live in [`data/pricing.json`](data/pricing.json), bundled and versioned in git. Cost is computed at query time, never stored, so correcting a rate fixes history retroactively. Models with no bundled rate render as `—`, never as `$0.00` — and any total containing one is marked unknown too, rather than quietly understating spend. `toklume doctor` lists every unpriced model it has seen.

> Costs are API-equivalent estimates, not invoices. Subscription plans do not bill per token.

## Privacy

This matters enough to be specific:

- **Zero network requests.** No telemetry, no update checks, no pricing fetches. The only networking code in the project is the loopback listener behind `toklume web`, which serves your own data to your own browser. There is no HTTP client anywhere in `src/`.
- **Reads only the log directories listed above.** Nothing else on your disk is touched.
- **Writes exactly one file:** `usage.db` in your platform data directory (`~/.local/share/toklume`, `~/Library/Application Support/toklume`, or `%APPDATA%\toklume`).
- **No prompts, messages, or code are ever parsed into the database.** Only token counts, message/session ids, model names, timestamps, and file paths. The parsers read `usage` objects and identifiers; they never touch message content. Verify it yourself:

  ```bash
  toklume query "SELECT * FROM events LIMIT 1"
  ```

  Every column is a number, an id, a model name, or a path.

Note that `project` and `source_file` do contain local directory paths, since that is what makes per-project reporting possible. If you share a database or a query result, that is the part to look at.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build

pnpm --dir web install && pnpm --dir web build   # dashboard bundle
```

Architecture, briefly: parsers turn raw log lines into `NormalizedEvent[]` and never touch the database; `core/scan.ts` owns incrementality for every parser; `db/queries.ts` is the only write path; `reports/` returns plain row arrays that both the CLI and the web server render. Adding a tool means writing one parser and registering it.

## License

MIT — see [LICENSE](LICENSE).
