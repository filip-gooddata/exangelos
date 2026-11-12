import { Context } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"
import type { DaemonContract } from "@exangelos/contracts"

/**
 * The daemon's agent group, the only part of the daemon contract the MCP server may call.
 * A client for the full contract narrows to it.
 */
export class AgentClient extends Context.Service<
  AgentClient,
  RpcClient.FromGroup<typeof DaemonContract.AgentGroup, RpcClientError.RpcClientError>
>()("@exangelos/mcp/AgentClient") {}
