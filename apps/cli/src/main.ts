import { SessionHeaders } from "@exangelos/contracts"
import { Daemon } from "@exangelos/daemon"
import { DaemonClient } from "@exangelos/daemon-client"
import { Plugin } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Console, Effect, Layer, Schema } from "effect"
import { CliError, CliOutput, Command } from "effect/cli"
import * as Build from "./Build.ts"

const encodePlugins = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(Plugin.Plugin)))

const daemon = Command.make("daemon", {}, () => Daemon.run)

const plugins = Command.make("plugins", {}, () =>
  Effect.gen(function*() {
    const client = yield* DaemonClient.DaemonClient
    const list = yield* client.ListPlugins()
    yield* Console.log(JSON.stringify(yield* encodePlugins(list), null, 2))
  }).pipe(Effect.provide(DaemonClient.layerFromPaths(SessionHeaders.detect(process.env)))))

const exangelos = Command.make("exangelos").pipe(Command.withSubcommands([daemon, plugins]))

const formatter = CliOutput.layer({
  ...CliOutput.defaultFormatter({ colors: false }),
  formatVersion: (name, version) => `${name} ${version}`
})

const describe = (cause: Cause.Cause<unknown>): string | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const error = Cause.squash(cause)
  if (CliError.isCliError(error)) return undefined
  if (error instanceof DaemonClient.DaemonNotRunning) return `no daemon runs on ${error.path}`
  if (error instanceof Daemon.DaemonAlreadyRunning) return `a daemon already runs on ${error.path}`
  return Cause.pretty(cause)
}

Command.run(exangelos, { version: Build.version }).pipe(
  Effect.tapCause((cause) => {
    const message = describe(cause)
    return message === undefined ? Effect.void : Console.error(message)
  }),
  Effect.provide(Layer.mergeAll(formatter, Paths.layer, BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: true })
)
