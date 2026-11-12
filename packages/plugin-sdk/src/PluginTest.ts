import { Effect, type Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { PluginProtocol } from "@exangelos/contracts"

export const makeClient = <A, E, R>(plugin: { readonly layer: Layer.Layer<A, E, R> }) =>
  RpcTest.makeClient(PluginProtocol.PluginProtocol).pipe(Effect.provide(plugin.layer))
