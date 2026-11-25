import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { writeSync } from "node:fs"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Template } from "@exangelos/connector-template"

/** Writes one line that is not JSON during a Watch, which then stays open. */
setInterval(() => {}, 1 << 30)

const handlers = ConnectorProtocol.ConnectorProtocol.toLayer({
  Handshake: () => Effect.succeed({ protocolVersion: ConnectorProtocol.version, catalogue: Template.connector.catalogue }),
  Configure: () => Effect.succeed({ _tag: "Accepted" } as const),
  Describe: () => Effect.die("unused"),
  Icon: () => Effect.succeed({ _tag: "None" } as const),
  Watch: () =>
    Stream.concat(
      Stream.make({ _tag: "Cursor" as const, cursor: "1" }),
      Stream.fromEffect(Effect.sync(() => writeSync(1, "not json\n"))).pipe(Stream.drain, Stream.concat(Stream.never))
    )
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
