import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Ran {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export interface Reply {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

const encode = (text: string) => Stream.encodeText(Stream.make(text))

export const make = (reply: (ran: Ran) => Reply = () => ({})) => {
  const ran: Array<Ran> = []
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const entry: Ran = {
          command: standard.command,
          args: standard.args.map((word) => (typeof word === "string" ? word : "<redacted>"))
        }
        ran.push(entry)
        const { exitCode = 0, stderr = "", stdout = "" } = reply(entry)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: encode(stdout),
          stderr: encode(stderr),
          all: Stream.concat(encode(stdout), encode(stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )
  return { ran, layer }
}

export type Fake = ReturnType<typeof make>

export const line = (ran: Ran) => [ran.command, ...ran.args].join(" ")
