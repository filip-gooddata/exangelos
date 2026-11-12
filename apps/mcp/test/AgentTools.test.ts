import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer, McpTest } from "effect/ai"
import { RpcTest } from "effect/rpc"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Ids, Subscription } from "@exangelos/domain"
import { AgentClient, handlers, layerSession, toolkit } from "@exangelos/mcp"

const at = DateTime.makeUnsafe("2026-11-12T09:00:00Z")

const existing: Subscription.Subscription = {
  id: Ids.SubscriptionId.make("sub_7f3k"),
  plugin: Ids.PluginName.make("github-pr"),
  parameters: { pr: "acme/app#123" },
  subject: "acme/app#123",
  label: "acme/app#123",
  intent: "fix CI when it fails",
  createdAt: at,
  expiresAt: at,
  state: { _tag: "Active" },
  stateSince: at,
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false
}

const notFaked = () => Effect.fail(new DaemonContract.InvalidRequest({ message: "not faked" }))

// The daemon side: refuses a second subscription on the same subject unless the caller says it is fine,
// and records the session it found in the request headers as the wake target.
const daemon = DaemonContract.AgentGroup.toLayer({
  ListPlugins: () => Effect.succeed([]),
  Subscribe: (payload, { headers }) =>
    payload.parameters["pr"] === existing.parameters["pr"] && payload.similarOk.length === 0
      ? Effect.fail(new DaemonContract.SimilarSubscriptions({ similar: [existing] }))
      : Effect.succeed({
        ...existing,
        id: Ids.SubscriptionId.make("sub_9q2m"),
        parameters: payload.parameters,
        intent: payload.intent,
        ...Option.match(SessionHeaders.fromHeaders(headers), {
          onNone: () => ({}),
          onSome: (wakeTarget) => ({ wakeTarget })
        })
      }),
  Update: notFaked,
  List: () => Effect.succeed([existing]),
  Show: notFaked,
  Events: notFaked,
  Ack: notFaked,
  Wait: ({ id }) =>
    Effect.succeed({
      subscription: id,
      plugin: "github-pr",
      subject: "acme/app#123",
      why: { _tag: "Events" as const },
      pending: [
        { number: 4, type: "checks.failed", summary: "build and e2e failed" },
        { number: 5, type: "review.submitted", summary: "alice requested changes" }
      ]
    }),
  Pause: notFaked,
  Resume: notFaked,
  Retarget: notFaked,
  Cancel: notFaked
})

const client = (env: Record<string, string>) =>
  McpTest.makeClient(
    McpServer.toolkit(toolkit).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(AgentClient, RpcTest.makeClient(DaemonContract.AgentGroup))),
      Layer.provide(daemon),
      Layer.provide(layerSession(SessionHeaders.detect(env)))
    ),
    { protocols: [McpProtocol.v2025_11_25] }
  )

const subscribeInput = { plugin: "github-pr", parameters: { pr: "acme/app#123" }, intent: "review comments" }

describe("MCP server", () => {
  it.effect("offers the agent group as tools and no management", () =>
    Effect.gen(function*() {
      const mcp = yield* client({})
      const { tools } = yield* mcp.listTools({})
      const names = tools.map((tool) => tool.name).sort()
      expect(names).toEqual(
        ["ack", "cancel", "events", "list", "list_plugins", "pause", "resume", "retarget", "show", "subscribe", "update", "wait"]
      )
      expect(names.filter((name) => /plugin_|import|enable|disable|remove|configure|link|setting|status|service/.test(name)))
        .toEqual([])
    }))

  it.effect("returns the daemon's answer", () =>
    Effect.gen(function*() {
      const mcp = yield* client({})
      const result = yield* mcp.callTool({ name: "list", arguments: {} })
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toMatchObject({ subscriptions: [{ id: "sub_7f3k", subject: "acme/app#123" }] })
    }))

  it.effect("reports a refusal as an error that says how to go on", () =>
    Effect.gen(function*() {
      const mcp = yield* client({})
      const result = yield* mcp.callTool({ name: "subscribe", arguments: subscribeInput })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{
        type: "text",
        text: [
          "Nothing was created: this session already has a similar open subscription.",
          "  sub_7f3k  parameters: pr=acme/app#123",
          "If you still want a separate subscription, call subscribe again with the same input plus similarOk: [\"sub_7f3k\"]."
        ].join("\n")
      }])
    }))

  it.effect("waits and returns the wake text", () =>
    Effect.gen(function*() {
      const mcp = yield* client({})
      const result = yield* mcp.callTool({ name: "wait", arguments: { id: "sub_7f3k" } })
      expect(result.structuredContent).toMatchObject({
        text: [
          "2 events on sub_7f3k (github-pr, acme/app#123)",
          "  #4 checks.failed      build and e2e failed",
          "  #5 review.submitted   alice requested changes",
          "Read  exangelos events sub_7f3k",
          "Ack   exangelos ack sub_7f3k --through 5"
        ].join("\n"),
        wake: { subscription: "sub_7f3k", pending: [{ number: 4 }, { number: 5 }] }
      })
    }))

  it.effect("sends the calling session in the request headers", () =>
    Effect.gen(function*() {
      const mcp = yield* client({ CLAUDE_CODE_SESSION_ID: "c-42", CODEX_THREAD_ID: "x-1" })
      const result = yield* mcp.callTool({
        name: "subscribe",
        arguments: { ...subscribeInput, similarOk: ["sub_7f3k"] }
      })
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toMatchObject({
        id: "sub_9q2m",
        wakeTarget: { harness: "claude-code", sessionId: "c-42" }
      })
    }))
})
