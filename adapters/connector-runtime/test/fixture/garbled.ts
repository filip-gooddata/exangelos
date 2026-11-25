import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { writeSync } from "node:fs"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Template } from "@exangelos/connector-template"

/** Writes one line that is not JSON before its first Configure answer, then answers normally. */
let configured = 0
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
  Watch: () => Stream.die("unused")
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
