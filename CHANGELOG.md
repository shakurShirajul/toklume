# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) (pre-1.0:
minor versions may include breaking changes).

## [0.2.0] - 2026-08-13

### Added

- Redesigned dashboard UI: a stacked tokens/day chart, a per-tool spend
  comparison table, a manual light/dark theme toggle, and a denser ledger-style
  layout for the daily and sessions views.
- Expandable session rows showing a per-session token-type breakdown.
- Syntax highlighting in the SQL console editor.
- A "sync" button in the dashboard that scans agent logs and ingests new usage
  on demand, without leaving the browser (`POST /api/sync`).
- Dashboard favicon and app icons (browser tab, iOS home screen, Android).

### Fixed

- CI: resolved a pnpm version conflict between the workflow config and
  `packageManager` in `package.json` that failed every run.
- CI: bumped the test/build Node version to 22, matching the build tool's
  minimum supported version.

## [0.1.2] - 2026-08-13

### Fixed

- Include the built web dashboard bundle in the published npm package.

## [0.1.1] - 2026-08-13

### Added

- Initial release: local SQLite ledger of AI coding agent token usage
  (Claude Code, Codex, OpenCode), CLI commands (`sync`, `daily`, `sessions`,
  `query`, `web`), and the first version of the web dashboard.
- `repository`, `homepage`, and `bugs` fields in `package.json`.
- Improvements to the web dashboard build script.
