import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Stream } from "effect"
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Template } from "@exangelos/connector-template"

/** A connector built before the Icon method: its group has only the first four. */
class Legacy extends RpcGroup.make(
  ConnectorProtocol.Handshake,
  ConnectorProtocol.Configure,
  ConnectorProtocol.Describe,
  ConnectorProtocol.Watch
) {}

const handlers = Legacy.toLayer({
  Handshake: () => Effect.succeed({ protocolVersion: ConnectorProtocol.version, catalogue: Template.connector.catalogue }),
  Configure: () => Effect.succeed({ _tag: "Accepted" } as const),
  Describe: () => Effect.die("unused"),
  Watch: () => Stream.die("unused")
})

RpcServer.layer(Legacy).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Layer.succeed(Logger.LogToStderr, true)),
  Layer.provide(BunStdio.layer),
  Layer.launch,
  BunRuntime.runMain
)
