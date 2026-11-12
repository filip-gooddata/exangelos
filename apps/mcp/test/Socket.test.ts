import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { RpcServer } from "effect/rpc"
import { mkdtempSync, rmSync } from "node:fs"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { DaemonClient, DaemonServer } from "@exangelos/daemon-client"
import { AgentClient, Messages } from "@exangelos/mcp"
import { handlers, mcpClient, subscribeInput } from "./daemon.ts"

const withSocket = <A, E, R>(use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync("/tmp/xg-mcp-")),
    (dir) => use(`${dir}/daemon.sock`),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
  )

const daemon = (path: string) =>
  RpcServer.layer(DaemonContract.AgentGroup).pipe(Layer.provide(handlers), Layer.provide(DaemonServer.layer(path)))

describe("MCP tools over the daemon socket", () => {
  it.live("send the calling session with each call", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        yield* Layer.build(daemon(path))
        const session = SessionHeaders.detect({ CLAUDE_CODE_SESSION_ID: "c-42", CODEX_THREAD_ID: "x-1" })
        const mcp = yield* mcpClient(AgentClient.layer(DaemonClient.layer({ path, session })))
        const result = yield* mcp.callTool({
          name: "subscribe",
          arguments: { ...subscribeInput, similarOk: ["sub_7f3k"] }
        })
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toMatchObject({
          id: "sub_9q2m",
          wakeTarget: { harness: "claude-code", sessionId: "c-42" }
        })
      }).pipe(Effect.scoped)
    ))

  it.live("say how to start the daemon when none answers", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const mcp = yield* mcpClient(AgentClient.layer(DaemonClient.layer({ path, session: Option.none() })))
        const result = yield* mcp.callTool({ name: "list", arguments: {} })
        expect(result.isError).toBe(true)
        expect(result.content).toEqual([
          { type: "text", text: Messages.noDaemonMessage(`nothing answers on ${path}`) }
        ])
      }).pipe(Effect.scoped)
    ))
})
