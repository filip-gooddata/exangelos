import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Sink, Stdio, Stream } from "effect"
import { RpcTest } from "effect/rpc"
import { DaemonContract } from "@exangelos/contracts"
import { AgentClient, layer, layerSession } from "@exangelos/mcp"

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

const notFaked = () => Effect.fail(new DaemonContract.InvalidRequest({ message: "not faked" }))

const daemon = DaemonContract.AgentGroup.toLayer({
  ListPlugins: () => Effect.succeed([]),
  Subscribe: notFaked,
  Update: notFaked,
  List: () => Effect.succeed([]),
  Show: notFaked,
  Events: notFaked,
  Ack: notFaked,
  Wait: notFaked,
  Pause: notFaked,
  Resume: notFaked,
  Retarget: notFaked,
  Cancel: notFaked
})

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
        layer({ version: "0.0.0" }).pipe(
          Layer.provide(Layer.effect(AgentClient, RpcTest.makeClient(DaemonContract.AgentGroup))),
          Layer.provide(daemon),
          Layer.provide(layerSession(Option.none())),
          Layer.provide(Stdio.layerTest({ stdin, stdout: () => stdout }))
        )
      )
      yield* Deferred.await(listed)
      const responses = written.join("").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line))
      const list = responses.find((response) => response.id === 2)
      expect(list.result.tools).toHaveLength(12)
      expect(responses.every((response) => response.jsonrpc === "2.0")).toBe(true)
    }))
})
