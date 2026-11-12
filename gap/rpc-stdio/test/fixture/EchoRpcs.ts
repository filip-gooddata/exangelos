import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export class EchoRpcs extends RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Count", { payload: { to: Schema.Finite }, success: Schema.Finite, stream: true }),
  Rpc.make("Tick", { success: Schema.Finite, stream: true }),
  Rpc.make("Stall")
) {}
