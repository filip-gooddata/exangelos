import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Schema, Stream } from "effect"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Template } from "@exangelos/connector-template"

/** An Icon method whose answer does not decode as the protocol's: the media type is a number. */
class Icon extends Rpc.make("Icon", {
  success: Schema.Struct({ _tag: Schema.Literal("Served"), mediaType: Schema.Number, data: Schema.String })
}) {}

class Legacy extends RpcGroup.make(
  ConnectorProtocol.Handshake,
  ConnectorProtocol.Configure,
  ConnectorProtocol.Describe,
  ConnectorProtocol.Watch,
  Icon
) {}

const handlers = Legacy.toLayer({
  Handshake: () => Effect.succeed({ protocolVersion: ConnectorProtocol.version, catalogue: Template.connector.catalogue }),
  Configure: () => Effect.succeed({ _tag: "Accepted" } as const),
  Describe: () => Effect.die("unused"),
  Watch: () => Stream.die("unused"),
  Icon: () => Effect.succeed({ _tag: "Served", mediaType: 1, data: "" } as const)
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
