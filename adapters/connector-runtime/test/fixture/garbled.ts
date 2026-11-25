import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { writeSync } from "node:fs"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Template } from "@exangelos/connector-template"

/**
 * Writes one line that is not JSON before its first Configure answer, and another during its first Watch, which
 * then stays open; it answers everything else normally.
 */
let configured = 0
let watched = 0
setInterval(() => {}, 1 << 30)

const handlers = ConnectorProtocol.ConnectorProtocol.toLayer({
  Handshake: () => Effect.succeed({ protocolVersion: ConnectorProtocol.version, catalogue: Template.connector.catalogue }),
  Configure: () =>
    Effect.sync(() => {
      if (configured++ === 0) writeSync(1, "not json\n")
      return { _tag: "Accepted" } as const
    }),
  Describe: () => Effect.die("unused"),
  Icon: () => Effect.succeed({ _tag: "None" } as const),
  Watch: () =>
    watched++ === 0
      ? Stream.concat(
        Stream.make({ _tag: "Cursor" as const, cursor: "1" }),
        Stream.fromEffect(Effect.sync(() => writeSync(1, "not json\n"))).pipe(Stream.drain, Stream.concat(Stream.never))
      )
      : Stream.make({ _tag: "Cursor" as const, cursor: "2" }, { _tag: "End" as const, reason: "done" })
})

RpcServer.layer(ConnectorProtocol.ConnectorProtocol).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Layer.succeed(Logger.LogToStderr, true)),
  Layer.provide(BunStdio.layer),
  Layer.launch,
  BunRuntime.runMain
)
