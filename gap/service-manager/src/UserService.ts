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

const validLabel = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

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
  const checked = <A>(operation: Operation, label: string, run: () => Effect.Effect<A, Failure>) =>
    validLabel.test(label)
      ? run().pipe(as(operation))
      : Effect.fail(new ServiceFailed({ operation, reason: `invalid service label: ${JSON.stringify(label)}` }))
  return UserService.of({
    install: (definition) => {
      const multiline = (["program", "description", "stdoutPath", "stderrPath"] as const)
        .find((field) => /[\r\n]/.test(definition[field]))
      return multiline === undefined
        ? checked("install", definition.label, () => operations.install(definition))
        : Effect.fail(new ServiceFailed({ operation: "install", reason: `${multiline} contains a line break` }))
    },
    start: (label) => checked("start", label, () => operations.start(label)),
    stop: (label) => checked("stop", label, () => operations.stop(label)),
    uninstall: (label) => checked("uninstall", label, () => operations.uninstall(label)),
    status: (label) => checked("status", label, () => operations.status(label))
  })
}
