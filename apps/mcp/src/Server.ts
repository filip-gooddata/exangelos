import { FileLog } from "@exangelos/logging"
import { Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { handlers, toolkit } from "./AgentTools.ts"

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

/** mcp.jsonl at the live level; WARN and above also to stderr, since stdout carries the protocol. */
export const logger = FileLog.layer({ src: "mcp", console: FileLog.stderrLogger("mcp", "Warn") })
