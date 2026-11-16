import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const ledgerTestTimeout = 60000

export const ledgerProcess = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const home = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "slack-ledger-contract-"))),
    (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
  )
  return ChildProcessSpawner.make((command) => Effect.gen(function*() {
    const standard = command as ChildProcess.StandardCommand
    if (standard.command !== "python3" || standard.args.length !== 1 || typeof standard.args[0] !== "string" || !standard.args[0].endsWith("/direct/ledger.py")) {
      throw new Error("Expected ledger command")
    }
    const script = standard.args[0]
    const input = standard.options.stdin
    if (typeof input !== "object" || input === null || !("stream" in input) || !Stream.isStream(input.stream)) {
      throw new Error("Expected ledger stdin")
    }
    const chunks = yield* input.stream.pipe(Stream.runCollect)
    const result = yield* Effect.callback<{ stdout: Buffer; code: number }>((resume) => {
      const child = execFile(standard.command, [script], {
        env: { ...process.env, EXANGELOS_HOME: home, PYTHONDONTWRITEBYTECODE: "1" },
        maxBuffer: 64000000, timeout: 45000, encoding: "buffer"
      }, (error, stdout) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          resume(Effect.die(new Error(`Ledger contract process failed: ${error.code}`)))
        } else resume(Effect.succeed({ stdout, code: typeof error?.code === "number" ? error.code : 0 }))
      })
      let closed = false
      child.once("close", () => { closed = true })
      child.stdin?.end(Buffer.concat(chunks))
      return Effect.promise<void>(() => new Promise((resolve) => {
        if (closed) return resolve()
        child.once("close", () => resolve())
        child.kill("SIGKILL")
      }))
    })
    const stdout = Stream.make(new Uint8Array(result.stdout ?? []))
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
      isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
      stdout, stderr: Stream.empty, all: stdout, getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
    })
  }))
}))
