import { Context, Effect, Layer, type Scope } from "effect"
import type { RpcClient } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { DaemonContract } from "@exangelos/contracts"
import { DaemonClient } from "@exangelos/daemon-client"

export type AgentRpcs = RpcClient.FromGroup<typeof DaemonContract.AgentGroup, RpcClientError>

export class AgentClient extends Context.Service<AgentClient, {
  /** A client for the agent group alone, connected for the life of the scope. Fails when no daemon answers. */
  readonly connect: Effect.Effect<AgentRpcs, DaemonClient.DaemonNotRunning, Scope.Scope>
}>()("@exangelos/mcp/AgentClient") {}

export const layer = (
  daemon: Layer.Layer<DaemonClient.DaemonClient, DaemonClient.DaemonNotRunning>
): Layer.Layer<AgentClient> =>
  Layer.succeed(AgentClient, {
    connect: Layer.build(daemon).pipe(
      Effect.map((context): AgentRpcs => Context.get(context, DaemonClient.DaemonClient))
    )
  })
