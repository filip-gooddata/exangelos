import { ServiceManager } from "@exangelos/application"
import type { Session } from "@exangelos/domain"
import { Daemon } from "@exangelos/daemon"
import { DaemonClient } from "@exangelos/daemon-client"
import { FileLog } from "@exangelos/logging"
import { AgentClient, Server } from "@exangelos/mcp"
import { Cause, Console, Effect, Layer, Logger, type Option } from "effect"
import { CliError, Command } from "effect/cli"
import * as Connection from "./commands/Connection.ts"
import { CommandFailed } from "./commands/Output.ts"
import * as Root from "./commands/Root.ts"
import * as Scaffold from "./commands/Scaffold.ts"
import { noDaemonMessage } from "./render/Messages.ts"

export const serviceManager = Daemon.serviceManager

export const daemonClient = <R>(
  session: Option.Option<Session.Session>,
  manager: Layer.Layer<ServiceManager.ServiceManager, never, R>
) => DaemonClient.layerStartingFromPaths(session).pipe(Layer.provide(manager))

const describe = (cause: Cause.Cause<unknown>): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const error = Cause.squash(cause)
  if (CliError.isCliError(error) || error instanceof CommandFailed) return undefined
  if (error instanceof DaemonClient.DaemonNotRunning) return noDaemonMessage(error.reason)
  if (error instanceof Daemon.DaemonAlreadyRunning) return `a daemon already runs on ${error.path}`
  return Cause.pretty(cause)
}

/** cli.jsonl at the live level; the terminal sees WARN and above, as before. */
export const logger = FileLog.layer({
  src: "cli",
  console: FileLog.atLeast("Warn", Logger.withConsoleError(Logger.formatSimple))
})

const started = (src: string, version: string) =>
  Effect.logInfo(`${src} started`).pipe(Effect.annotateLogs({ version }))

export const run = <R>(options: {
  readonly version: string
  readonly client: Layer.Layer<DaemonClient.DaemonClient, DaemonClient.DaemonNotRunning, R>
  readonly daemon: Daemon.Options
}) =>
(argv: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const client = Layer.provide(options.client, Layer.succeedContext(yield* Effect.context<R>()))
    const daemon = Command.make("daemon", {}, () => Daemon.run({ ...options.daemon, version: options.version })).pipe(
      Command.withDescription("Run the daemon in the foreground, as the service definitions do")
    )
    const mcp = Command.make("mcp", {}, () =>
      started("mcp", options.version).pipe(
        Effect.andThen(Layer.launch(Server.layer({ version: options.version }).pipe(Layer.provide(AgentClient.layer(client))))),
        Effect.provide(Server.logger)
      )).pipe(
        Command.withDescription("Serve the agent tools over MCP on stdio")
      )
    const root = Root.make({
      commands: [daemon, mcp],
      connectorCommands: [Scaffold.command],
      started: started("cli", options.version)
    })
    yield* Command.runWith(root, { version: options.version })(argv).pipe(Effect.provide(Connection.layer(client)))
  }).pipe(
    Effect.tapCause((cause) => {
      const message = describe(cause)
      return message === undefined ? Effect.void : Console.error(message)
    }),
    Effect.provide(logger)
  )
