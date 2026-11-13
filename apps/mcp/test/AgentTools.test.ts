import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { inMemory, mcpClient, subscribeInput } from "./daemon.ts"

describe("MCP tools", () => {
  it.effect("offers the agent group as tools and no management", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
      const { tools } = yield* mcp.listTools({})
      const names = tools.map((tool) => tool.name).sort()
      expect(names).toEqual(
        ["ack", "cancel", "events", "list", "list_connectors", "pause", "resume", "retarget",
          "set_event_alerts", "show", "subscribe", "update", "wait"]
      )
      expect(names.filter((name) => /connector_|import|enable|disable|remove|configure|link|setting|status|service/.test(name)))
        .toEqual([])
    }))

  it.effect("returns the daemon's answer", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
      const result = yield* mcp.callTool({ name: "list", arguments: {} })
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toMatchObject({ subscriptions: [{ id: "sub_7f3k", subject: "acme/app#123" }] })
    }))

  it.effect("reports a refusal as an error that says how to go on", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
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

  it.effect("switches event alerts on the caller's subscription and refuses another session's", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
      const own = yield* mcp.callTool({ name: "set_event_alerts", arguments: { id: "sub_7f3k", eventAlerts: true } })
      expect(own.structuredContent).toMatchObject({ id: "sub_7f3k", eventAlerts: true })

      const refused = yield* mcp.callTool({ name: "set_event_alerts", arguments: { id: "sub_else", eventAlerts: true } })
      expect(refused.isError).toBe(true)
      expect(refused.content).toEqual([{
        type: "text",
        text:
          "Nothing changed: only the session that created sub_else, or the user, may switch its event alerts. Ask the user to run `exangelos alerts sub_else on` or `off`."
      }])
    }))

  it.effect("names the ack call to make when resume is refused for a backlog over the limit", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
      const result = yield* mcp.callTool({ name: "resume", arguments: { id: "sub_full" } })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{
        type: "text",
        text:
          "Not resumed: 3 events are pending, and the oldest is older than the backlog allows. Acknowledge them first: call ack with id: \"sub_full\", through: 27, then call resume."
      }])
    }))

  it.effect("waits and returns the wake text", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
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

  it.effect("tells a Claude Code session to wait in the background", () =>
    Effect.gen(function*() {
      const mcp = yield* mcpClient(inMemory)
      const claude = yield* mcp.callTool({ name: "resume", arguments: { id: "sub_cc" } })
      const t3 = yield* mcp.callTool({ name: "resume", arguments: { id: "sub_t3" } })
      expect(claude.structuredContent).toMatchObject({
        hint:
          "Claude Code sessions don't receive wakes yet: run `exangelos wait sub_cc` as a background command; it returns when there is something to say."
      })
      expect(claude.content).toMatchObject([{ type: "text", text: expect.stringMatching(/something to say\."\}$/) }])
      expect(t3.structuredContent).not.toHaveProperty("hint")
    }))
})
