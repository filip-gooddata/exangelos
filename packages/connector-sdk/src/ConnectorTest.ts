import { Effect, type Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { ConnectorProtocol } from "@exangelos/contracts"

export const makeClient = <A, E, R>(connector: { readonly layer: Layer.Layer<A, E, R> }) =>
  RpcTest.makeClient(ConnectorProtocol.ConnectorProtocol).pipe(Effect.provide(connector.layer))
