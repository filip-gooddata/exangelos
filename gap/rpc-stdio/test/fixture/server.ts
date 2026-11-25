import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schedule, Stream } from "effect"
import { existsSync } from "node:fs"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { EchoRpcs } from "./EchoRpcs.ts"

const handlers = EchoRpcs.toLayer({
  Echo: ({ text }) => Effect.succeed(text),
  Count: ({ to }) => Stream.range(1, to),
  Tick: () => Stream.concat(Stream.make(1), Stream.never),
  Stall: () => Effect.never
})

const gate = process.argv[2]

const awaitGate = gate === undefined
  ? Effect.void
  : Effect.sync(() => existsSync(gate)).pipe(Effect.repeat({ until: (open) => open, schedule: Schedule.spaced("10 millis") }))

RpcServer.layer(EchoRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(BunServices.layer),
  Layer.launch,
  (launch) => Effect.andThen(awaitGate, launch),
  BunRuntime.runMain
)
