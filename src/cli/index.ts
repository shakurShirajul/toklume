#!/usr/bin/env node
import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty'
import pc from 'picocolors'
import { errorMessage } from '../core/paths.js'
import { syncCommand } from './commands/sync.js'
import { dailyCommand } from './commands/daily.js'
import { sessionsCommand } from './commands/sessions.js'
import { queryCommand } from './commands/query.js'
import { doctorCommand } from './commands/doctor.js'
import { webCommand } from './commands/web.js'

const VERSION = '0.1.0'

const subCommands = {
  sync: syncCommand,
  daily: dailyCommand,
  sessions: sessionsCommand,
  query: queryCommand,
  doctor: doctorCommand,
  web: webCommand,
}

const main = defineCommand({
  meta: {
    name: 'toklume',
    version: VERSION,
    description:
      'A local SQLite database of your AI coding agent token usage. No daemon, no cloud, no account.',
  },
  subCommands,
})

/**
 * Entry point.
 *
 * citty's own runMain() reports failures with consola.error(error), which
 * prints a stack trace. The errors users actually hit here — an unwritable
 * data directory, a missing database, a rejected SQL statement — are expected
 * conditions, not bugs, so we drive runCommand() directly and print a single
 * readable line instead.
 */
async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2)

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    const name = rawArgs[0]
    const sub = name !== undefined ? (subCommands as Record<string, CommandDef>)[name] : undefined
    if (sub) await showUsage(sub, main)
    else await showUsage(main)
    return
  }

  if (rawArgs.length === 1 && (rawArgs[0] === '--version' || rawArgs[0] === '-v')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  if (rawArgs.length === 0) {
    await showUsage(main)
    return
  }

  await runCommand(main, { rawArgs })
}

run().catch((err: unknown) => {
  process.stderr.write(`${pc.red('error')} ${errorMessage(err)}\n`)
  process.exit(1)
})
