import { resolve } from "node:path"
import { Duration, Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"
import type { RpcClientError } from "effect/rpc"
import { ConnectorRuntime } from "@exangelos/application"
import { ConnectorProtocol } from "@exangelos/contracts"
import { RpcStdio } from "@exangelos/rpc-stdio"

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

export type CommandFor = (launch: ConnectorRuntime.Launch) => Command

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

export const supportedVersions: ReadonlyArray<number> = [ConnectorProtocol.version]

export interface Options {
  readonly commandFor?: CommandFor | undefined
  /** How long a connector may take to answer the handshake. Defaults to 30 seconds. */
  readonly startTimeout?: Duration.Input | undefined
  readonly stopTimeout?: Duration.Input | undefined
}

/**
 * A ConnectorRuntime that spawns each connector as a child process in its directory and
 * speaks the connector protocol over its stdin and stdout. The connector's stderr goes
 * to the daemon's stderr. Closing the scope passed to `start` stops the process, killing it
 * when it outlives the stop timeout.
 */
export const make = Effect.fnUntraced(function*(options?: Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const commandFor = options?.commandFor ?? defaultCommand
  const startTimeout = Duration.fromInputUnsafe(options?.startTimeout ?? "30 seconds")
  const stopTimeout = options?.stopTimeout ?? "5 seconds"

  const acquire = Effect.fnUntraced(function*(launch: ConnectorRuntime.Launch) {
    const connector = launch.name
    const startFailed = (reason: string) => new ConnectorRuntime.ConnectorStartFailed({ connector, reason })
    const crashed = (reason: string) => new ConnectorRuntime.ConnectorCrashed({ connector, reason })
    const lost = (error: RpcClientError.RpcClientError) => crashed(`Lost the connector's connection: ${error.message}`)

    const { args, command, env } = commandFor(launch)
    const child = yield* ChildProcess.make(command, args, {
      cwd: launch.directory,
      env,
      extendEnv: true,
      stderr: "inherit",
      forceKillAfter: stopTimeout
    }).pipe(Effect.mapError((error) => startFailed(error.message)))

    const { catalogue, client } = yield* Effect.gen(function*() {
      const protocol = yield* RpcStdio.makeProtocol(child)
      const client = yield* RpcClient.make(ConnectorProtocol.ConnectorProtocol).pipe(
        Effect.provideService(RpcClient.Protocol, protocol)
      )
      const handshake = yield* client.Handshake().pipe(Effect.mapError((error) => startFailed(error.message)))
      return { catalogue: handshake.catalogue, client, version: handshake.protocolVersion }
    }).pipe(
      Effect.timeoutOrElse({
        duration: startTimeout,
        orElse: () =>
          Effect.fail(startFailed(`The connector did not answer the handshake within ${Duration.format(startTimeout)}`))
      }),
      Effect.filterOrFail(
        ({ version }) => supportedVersions.includes(version),
        ({ version }) => new ConnectorRuntime.IncompatibleProtocol({ connector, version, supported: supportedVersions })
      )
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
              return new ConnectorRuntime.CredentialsRejected({ connector, reason: error.reason })
            case "SourceFailed":
              return new ConnectorRuntime.SourceFailed({ connector, reason: error.reason })
          }
        })),
      exited: child.exitCode.pipe(
        Effect.match({
          onSuccess: (code) => crashed(`The connector exited with code ${code}`),
          onFailure: (error) => crashed(error.message)
        })
      )
    } satisfies ConnectorRuntime.ConnectorProcess
  }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

  const start = Effect.fnUntraced(function*(launch: ConnectorRuntime.Launch) {
    const scope = yield* Scope.fork(yield* Scope.Scope)
    return yield* acquire(launch).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
  })

  return ConnectorRuntime.ConnectorRuntime.of({ start })
})

export const layer = (options?: Options): Layer.Layer<ConnectorRuntime.ConnectorRuntime, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ConnectorRuntime.ConnectorRuntime, make(options))
