import { Context, Data, Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface ServiceDefinition {
  readonly label: string
  readonly program: string
  readonly arguments: ReadonlyArray<string>
  readonly environment: Record<string, string>
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly description: string
}

export type ServiceStatus = Data.TaggedEnum<{
  NotInstalled: {}
  Stopped: {}
  Running: { readonly pid?: number }
}>

export const ServiceStatus = Data.taggedEnum<ServiceStatus>()

export type Operation = "install" | "start" | "stop" | "uninstall" | "status"

export class ServiceFailed extends Data.TaggedError("ServiceFailed")<{
  readonly operation: Operation
  readonly reason: string
}> {}

export class UserService extends Context.Service<UserService, {
  readonly install: (definition: ServiceDefinition) => Effect.Effect<void, ServiceFailed>
  readonly start: (label: string) => Effect.Effect<void, ServiceFailed>
  readonly stop: (label: string) => Effect.Effect<void, ServiceFailed>
  readonly uninstall: (label: string) => Effect.Effect<void, ServiceFailed>
  readonly status: (label: string) => Effect.Effect<ServiceStatus, ServiceFailed>
}>()("@exangelos/service-manager/UserService") {}

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly reason: string
}> {}

type Failure = CommandFailed | PlatformError

export interface Output {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const commandFailed = (command: string, args: ReadonlyArray<string>, output: Output) =>
  new CommandFailed({
    reason: `${[command, ...args].join(" ")} exited with ${output.exitCode}: ${output.stderr.trim()}`
  })

export const makeRunner = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = (command: string, args: ReadonlyArray<string>): Effect.Effect<Output, PlatformError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args))
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: "unbounded" })
        return { exitCode, stdout, stderr }
      })
    )
  const succeed = (
    command: string,
    args: ReadonlyArray<string>,
    tolerate: ReadonlyArray<number> = []
  ): Effect.Effect<Output, Failure> =>
    output(command, args).pipe(
      Effect.filterOrFail(
        (result) => result.exitCode === 0 || tolerate.includes(result.exitCode),
        (result) => commandFailed(command, args, result)
      )
    )
  return { output, succeed }
})

export const makeUserService = (operations: {
  readonly install: (definition: ServiceDefinition) => Effect.Effect<void, Failure>
  readonly start: (label: string) => Effect.Effect<void, Failure>
  readonly stop: (label: string) => Effect.Effect<void, Failure>
  readonly uninstall: (label: string) => Effect.Effect<void, Failure>
  readonly status: (label: string) => Effect.Effect<ServiceStatus, Failure>
}) => {
  const as = (operation: Operation) =>
    Effect.mapError((error: Failure) =>
      new ServiceFailed({ operation, reason: error._tag === "CommandFailed" ? error.reason : error.message })
    )
  return UserService.of({
    install: (definition) => operations.install(definition).pipe(as("install")),
    start: (label) => operations.start(label).pipe(as("start")),
    stop: (label) => operations.stop(label).pipe(as("stop")),
    uninstall: (label) => operations.uninstall(label).pipe(as("uninstall")),
    status: (label) => operations.status(label).pipe(as("status"))
  })
}
