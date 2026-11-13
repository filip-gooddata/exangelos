import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { ConnectorProtocol } from "@exangelos/contracts"
import { Connector } from "@exangelos/connector-sdk"
import { Template } from "@exangelos/connector-template"

const handlers = ConnectorProtocol.ConnectorProtocol.toLayer({
  Handshake: () =>
    Effect.succeed({ protocolVersion: ConnectorProtocol.version + 1, catalogue: Template.connector.catalogue }),
  Configure: () => Effect.die("unused"),
  Describe: () => Effect.die("unused"),
  Watch: () => Stream.die("unused")
})

Connector.serve({ layer: handlers }).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
