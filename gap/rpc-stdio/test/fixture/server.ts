import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { EchoRpcs } from "./EchoRpcs.ts"

const handlers = EchoRpcs.toLayer({
  Echo: ({ text }) => Effect.succeed(text),
  Count: ({ to }) => Stream.range(1, to),
  Tick: () => Stream.concat(Stream.make(1), Stream.never),
  Stall: () => Effect.never
})

const startupDelay = Duration.millis(Number(process.argv[2] ?? 0))

RpcServer.layer(EchoRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(BunServices.layer),
  Layer.launch,
  Effect.delay(startupDelay),
  BunRuntime.runMain
)
