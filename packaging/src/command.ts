import { Data, Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

export interface CommandOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

const describe = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(" ")

const spawnFailed = (command: string, args: ReadonlyArray<string>) => (error: PlatformError) =>
  new CommandFailed({ message: `${describe(command, args)} failed: ${error.message}` })

const checkExit = (command: string, args: ReadonlyArray<string>, exitCode: number) =>
  exitCode === 0
    ? Effect.void
    : Effect.fail(new CommandFailed({ message: `${describe(command, args)} exited with code ${exitCode}` }))

const make = (command: string, args: ReadonlyArray<string>, options: CommandOptions, stdout: "ignore" | "pipe") =>
  ChildProcess.make(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
    stdin: "ignore",
    stdout,
    stderr: "inherit"
  })

export const run = (command: string, args: ReadonlyArray<string>, options: CommandOptions = {}) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner.exitCode(make(command, args, options, "ignore")).pipe(
      Effect.mapError(spawnFailed(command, args))
    )
    yield* checkExit(command, args, exitCode)
  })

export const output = (command: string, args: ReadonlyArray<string>, options: CommandOptions = {}) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [text, exitCode] = yield* Effect.scoped(
      Effect.flatMap(spawner.spawn(make(command, args, options, "pipe")), (handle) =>
        Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], { concurrency: 2 }))
    ).pipe(Effect.mapError(spawnFailed(command, args)))
    yield* checkExit(command, args, exitCode)
    return text
  })
