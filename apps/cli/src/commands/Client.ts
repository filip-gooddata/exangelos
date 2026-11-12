import { Context } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"
import type { DaemonContract } from "@exangelos/contracts"

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError.RpcClientError>
>()("@exangelos/cli/DaemonClient") {}
