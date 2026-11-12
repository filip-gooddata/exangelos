import { Effect, Layer, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Call {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
}

export interface Reply {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

const text = (value: string | undefined) => Stream.encodeText(Stream.make(value ?? ""))

const stdinOf = (command: ChildProcess.StandardCommand) => {
  const input = command.options.stdin
  const stream = typeof input === "object" && "stream" in input ? input.stream : input
  return typeof stream === "object" ? Stream.mkString(Stream.decodeText(stream)) : Effect.succeed("")
}

/** A ChildProcessSpawner that records each call and answers from `reply`; a missing command fails to spawn. */
export const make = (reply: (call: Call) => Reply | "missing") => {
  const calls: Array<Call> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") return yield* Effect.die("piped commands are not faked")
      const call: Call = {
        command: command.command,
        args: command.args.map(String),
        stdin: yield* stdinOf(command)
      }
      calls.push(call)
      const answer = reply(call)
      if (answer === "missing") {
        return yield* PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" })
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: text(answer.stdout),
        stderr: text(answer.stderr),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) }
}
