import { Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

export interface CommandOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

const make = (command: string, args: ReadonlyArray<string>, options: CommandOptions) =>
  ChildProcess.make(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
    stdin: "ignore",
    stderr: "inherit"
  })

const failed = (command: string, args: ReadonlyArray<string>, reason: string) =>
  new CommandFailed({ message: `${[command, ...args].join(" ")} ${reason}` })

const checkExit = (command: string, args: ReadonlyArray<string>) => (exitCode: number) =>
  exitCode === 0 ? Effect.void : Effect.fail(failed(command, args, `exited with code ${exitCode}`))

export const run = (command: string, args: ReadonlyArray<string>, options: CommandOptions = {}) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const exitCode = yield* spawner.exitCode(ChildProcess.make(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit"
    })).pipe(Effect.mapError((error) => failed(command, args, `failed: ${error.message}`)))
    yield* checkExit(command, args)(exitCode)
  })

export const output = (command: string, args: ReadonlyArray<string>, options: CommandOptions = {}) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(make(command, args, options))
    const [text, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
      concurrency: 2
    })
    yield* checkExit(command, args)(exitCode)
    return text
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(failed(command, args, `failed: ${error.message}`)))
  )
