import { Layer, Option } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { Headers } from "effect/http"
import { RpcClient } from "effect/rpc"
import { SessionHeaders } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { handlers, toolkit } from "./AgentTools.ts"

/**
 * Sends the calling session with every daemon call as request headers.
 * Without a session no headers go out, and the daemon refuses a call that needs one.
 * Provide it to `layer`: the tool handlers keep the headers present when they are built.
 */
export const layerSession = (session: Option.Option<Session.Session>): Layer.Layer<never> =>
  Option.match(session, {
    onNone: () => Layer.empty,
    onSome: (found) => Layer.succeed(RpcClient.CurrentHeaders, Headers.fromInput(SessionHeaders.toHeaders(found)))
  })

/** The agent tools as an MCP server on stdio. stdout carries protocol frames only. */
export const layer = (options: { readonly version: string }) =>
  McpServer.toolkit(toolkit).pipe(
    Layer.provideMerge(
      McpServer.layerStdio({
        name: "exangelos",
        version: options.version,
        instructions: "Subscribe to events from external sources and get woken when they arrive.",
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26]
      })
    ),
    Layer.provide(handlers)
  )
