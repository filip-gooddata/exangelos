import { expect, it } from "@effect/vitest"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { localSource } from "../src/Source.ts"

const request = { selection: { workspace: "fixture-workspace", owner: "fixture-owner", conversations: ["fixture-conversation"] }, key: "a".repeat(64) }
const snapshot = { scope: "b".repeat(64), complete: true, generation: "1", snapshot: "c".repeat(64), messages: [] }
const processLayer = (output: Uint8Array, code = 0) => Layer.succeed(ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) => Effect.gen(function*() {
    const standard = command as ChildProcess.StandardCommand
    expect(standard.command).toBe("python3")
    expect(standard.args).toHaveLength(1)
    expect(standard.args[0]).toMatch(/\/direct\/source.py$/)
    expect(JSON.stringify(standard.args)).not.toContain(request.key)
    const input = standard.options.stdin
    if (typeof input !== "object" || input === null || !("stream" in input)) throw new Error("Expected stdin configuration")
    if (!Stream.isStream(input.stream)) throw new Error("Expected stdin stream")
    const chunks = yield* input.stream.pipe(Stream.runCollect)
    expect(JSON.parse(chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""))).toEqual(request)
    const stdout = Stream.make(output)
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
      stdout, stderr: Stream.empty, all: stdout, getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
    })
  })))

it.effect("source passes private configuration only on stdin and decodes a keyed snapshot", () =>
  localSource.read(request).pipe(
    Effect.provide(processLayer(new TextEncoder().encode(JSON.stringify(snapshot)))),
    Effect.map((result) => expect(result).toEqual(snapshot))
  ))

it.effect("source sanitizes nonzero exit, malformed output, oversized output and invalid UTF-8", () => Effect.gen(function*() {
  for (const [output, code] of [
    [new TextEncoder().encode("fixture-private-error"), 1],
    [new TextEncoder().encode('{"scope":"fixture-private-value"}'), 0],
    [new Uint8Array(4000001), 0],
    [new Uint8Array([255]), 0]
  ] as const) {
    const failure = yield* localSource.read(request).pipe(Effect.provide(processLayer(output, code)), Effect.flip)
    expect(failure._tag).toBe("SourceUnavailable")
    expect(JSON.stringify(failure)).not.toContain("fixture-")
  }
}))

it.effect("source retains only a bounded failure category from the helper", () => Effect.gen(function*() {
  for (const [exit, category] of [[21, "unreadable"], [24, "scope-changed"], [1, "invalid-data"], [99, "unavailable"]] as const) {
    const fault = yield* localSource.read(request).pipe(
      Effect.provide(processLayer(new TextEncoder().encode("fixture-private-output"), exit)), Effect.flip
    )
    expect(fault.category).toBe(category)
    expect(JSON.stringify(fault)).not.toContain("fixture")
  }
}))
