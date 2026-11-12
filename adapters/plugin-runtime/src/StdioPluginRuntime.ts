import { resolve } from "node:path"
import { Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import type { RpcClientError } from "effect/rpc"
import { PluginRuntime } from "@exangelos/application"
import { PluginProtocol } from "@exangelos/contracts"
import { RpcStdio } from "@exangelos/rpc-stdio"

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

export type CommandFor = (launch: PluginRuntime.Launch) => Command

/**
 * Runs a JS bundle on the Bun runtime that the current executable carries, and a
 * native entry as its own executable.
 */
export const defaultCommand: CommandFor = (launch) => {
  const entry = resolve(launch.directory, launch.entry.path)
  return launch.entry._tag === "Bundle"
    ? { command: process.execPath, args: [entry], env: { BUN_BE_BUN: "1" } }
    : { command: entry, args: [], env: {} }
}

export const supportedVersions: ReadonlyArray<number> = [PluginProtocol.version]

export interface Options {
  readonly commandFor?: CommandFor | undefined
  /** How long a plugin may take to answer the handshake. Defaults to 30 seconds. */
  readonly startTimeout?: Duration.Input | undefined
}

/**
 * A PluginRuntime that spawns each plugin as a child process in its directory and
 * speaks the plugin protocol over its stdin and stdout. The plugin's stderr goes
 * to the daemon's stderr. Closing the scope passed to `start` stops the process.
 */
export const make = Effect.fnUntraced(function*(options?: Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const commandFor = options?.commandFor ?? defaultCommand
  const startTimeout = Duration.fromInputUnsafe(options?.startTimeout ?? "30 seconds")

  const start = Effect.fnUntraced(function*(launch: PluginRuntime.Launch) {
    const plugin = launch.name
    const startFailed = (reason: string) => new PluginRuntime.PluginStartFailed({ plugin, reason })
    const crashed = (reason: string) => new PluginRuntime.PluginCrashed({ plugin, reason })
    const lost = (error: RpcClientError.RpcClientError) => crashed(`Lost the plugin's connection: ${error.message}`)

    const { args, command, env } = commandFor(launch)
    const child = yield* ChildProcess.make(command, args, {
      cwd: launch.directory,
      env,
      extendEnv: true,
      stderr: "inherit"
    }).pipe(Effect.mapError((error) => startFailed(error.message)))

    const { catalogue, client } = yield* Effect.gen(function*() {
      const protocol = yield* RpcStdio.makeProtocol(child)
      const client = yield* RpcClient.make(PluginProtocol.PluginProtocol).pipe(
        Effect.provideService(RpcClient.Protocol, protocol)
      )
      const handshake = yield* client.Handshake().pipe(Effect.mapError((error) => startFailed(error.message)))
      return { catalogue: handshake.catalogue, client, version: handshake.protocolVersion }
    }).pipe(
      Effect.timeoutOrElse({
        duration: startTimeout,
        orElse: () =>
          Effect.fail(startFailed(`The plugin did not answer the handshake within ${Duration.format(startTimeout)}`))
      }),
      Effect.filterOrFail(
        ({ version }) => supportedVersions.includes(version),
        ({ version }) => new PluginRuntime.IncompatibleProtocol({ plugin, version, supported: supportedVersions })
      ),
      Effect.onError(() => Effect.ignore(child.kill()))
    )

    return {
      catalogue,
      configure: (values) => client.Configure({ values }).pipe(Effect.mapError(lost)),
      describe: (parameters) => client.Describe({ parameters }).pipe(Effect.mapError(lost)),
      watch: (request) =>
        client.Watch(request).pipe(Stream.mapError((error) => {
          switch (error._tag) {
            case "RpcClientError":
              return lost(error)
            case "CredentialsRejected":
              return new PluginRuntime.CredentialsRejected({ plugin, reason: error.reason })
            case "SourceFailed":
              return new PluginRuntime.SourceFailed({ plugin, reason: error.reason })
          }
        })),
      exited: child.exitCode.pipe(
        Effect.match({
          onSuccess: (code) => crashed(`The plugin exited with code ${code}`),
          onFailure: (error) => crashed(error.message)
        })
      )
    } satisfies PluginRuntime.PluginProcess
  }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

  return PluginRuntime.PluginRuntime.of({ start })
})

export const layer = (options?: Options): Layer.Layer<PluginRuntime.PluginRuntime, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(PluginRuntime.PluginRuntime, make(options))
