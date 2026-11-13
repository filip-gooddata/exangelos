import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Sink, Stdio, Stream } from "effect"
import { Server } from "@exangelos/mcp"
import { inMemory } from "./daemon.ts"

const frames = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
]

describe("MCP server on stdio", () => {
  it.effect("answers tools/list with protocol frames only", () =>
    Effect.gen(function*() {
      const written: Array<string> = []
      const listed = yield* Deferred.make<void>()
      const bytes = (frame: object) => Uint8Array.from(`${JSON.stringify(frame)}\n`, (char) => char.charCodeAt(0))
      const stdin = Stream.make(...frames.map(bytes)).pipe(Stream.concat(Stream.never))
      const stdout = Sink.forEach((chunk: string | Uint8Array) =>
        Effect.suspend(() => {
          const text = typeof chunk === "string" ? chunk : String.fromCharCode(...chunk)
          written.push(text)
          return text.includes("\"id\":2") ? Deferred.succeed(listed, undefined) : Effect.void
        })
      )
      yield* Layer.build(
        Server.layer({ version: "0.0.0" }).pipe(
          Layer.provide(inMemory),
          Layer.provide(Stdio.layerTest({ stdin, stdout: () => stdout }))
        )
      )
      yield* Deferred.await(listed)
      const responses = written.join("").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line))
      const list = responses.find((response) => response.id === 2)
      expect(list.result.tools).toHaveLength(13)
      expect(responses.every((response) => response.jsonrpc === "2.0")).toBe(true)
    }))
})
