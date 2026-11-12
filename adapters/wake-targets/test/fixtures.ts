import { Effect, Layer, Ref, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { ChildProcess } from "effect/process"
import { Ids } from "@exangelos/domain"
import type { Wake } from "@exangelos/domain"
import type { Outcome } from "../src/Attempt.ts"

export const content: Wake.WakeContent = {
  subscription: Ids.SubscriptionId.make("sub_7f3k"),
  plugin: "github-pr",
  subject: "acme/app#123",
  why: { _tag: "Events" },
  pending: [{ number: 4, type: "checks.failed", summary: "build and e2e failed" }]
}

export const exited = (exitCode: number, stdout = "", stderr = ""): Outcome => ({ _tag: "Exited", exitCode, stdout, stderr })

export interface Spawned {
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
}

/** A command runner that records each command and answers with the given exit code and output. */
export const recordingSpawner = (answer: { readonly exitCode: number; readonly stdout?: string }) =>
  Effect.gen(function*() {
    const spawned = yield* Ref.make<ReadonlyArray<Spawned>>([])
    const spawn = (command: ChildProcess.Command) =>
      Effect.gen(function*() {
        if (command._tag !== "StandardCommand") return yield* Effect.die("piped commands are not expected")
        const input = command.options.stdin
        const stdin = Stream.isStream(input) ? yield* Stream.mkString(Stream.decodeText(input)) : ""
        yield* Ref.update(spawned, (all) => [...all, { program: command.command, args: command.args.map(String), stdin }])
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(answer.stdout ?? "")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    return {
      layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
      spawned: Ref.get(spawned)
    }
  })
