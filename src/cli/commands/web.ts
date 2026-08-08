import { defineCommand } from 'citty'
import pc from 'picocolors'
import { createWebServer } from '../../web/server.js'
import { printLine } from '../../output/table.js'
import { defaultDbPath } from '../../core/paths.js'

export const webCommand = defineCommand({
  meta: {
    name: 'web',
    description: 'Serve the local dashboard on 127.0.0.1',
  },
  args: {
    db: { type: 'string', description: 'Override the database path' },
    port: { type: 'string', description: 'Port to listen on (default 4477)' },
    host: { type: 'string', description: 'Host to bind (default 127.0.0.1)' },
  },
  run({ args }) {
    const portArg = args.port as string | undefined
    const port = portArg === undefined ? 4477 : Number.parseInt(portArg, 10)
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`--port must be a number between 1 and 65535, got "${portArg}"`)
    }

    // Loopback by default: the dashboard exposes your full usage history and
    // an arbitrary-SQL endpoint, so it must not be reachable off-machine
    // unless the user explicitly asks for that.
    const host = (args.host as string | undefined) ?? '127.0.0.1'

    const { server, assetDir } = createWebServer({
      dbPath: args.db as string | undefined,
      port,
      host,
    })

    return new Promise<void>((resolve, reject) => {
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Try \`toklume web --port ${port + 1}\`.`))
          return
        }
        reject(err)
      })

      server.listen(port, host, () => {
        printLine(`${pc.green('▸')} ${pc.bold('toklume')} dashboard`)
        printLine(`  url       ${pc.cyan(`http://${host}:${port}`)}`)
        printLine(`  database  ${(args.db as string | undefined) ?? defaultDbPath()}`)
        if (!assetDir) {
          printLine(
            `  ${pc.yellow('note')}      dashboard bundle not built — serving the API only`,
          )
          printLine(`            build it with ${pc.dim('pnpm --dir web install && pnpm --dir web build')}`)
        }
        printLine()
        printLine(pc.dim('Local only. No outbound requests. Ctrl+C to stop.'))
      })

      const shutdown = () => {
        server.close(() => resolve())
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
  },
})
