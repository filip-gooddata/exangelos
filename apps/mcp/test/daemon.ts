import { DateTime, Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer, McpTest } from "effect/ai"
import { RpcTest } from "effect/rpc"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Ids, type Subscription } from "@exangelos/domain"
import { AgentClient, AgentTools } from "@exangelos/mcp"

const at = DateTime.makeUnsafe("2026-11-12T09:00:00Z")

export const existing: Subscription.Subscription = {
  id: Ids.SubscriptionId.make("sub_7f3k"),
  connector: Ids.ConnectorName.make("github-pr"),
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

export const handlers = DaemonContract.AgentGroup.toLayer({
  ListConnectors: () => Effect.succeed([]),
  Subscribe: (payload, { headers }) =>
    payload.parameters["pr"] === existing.parameters["pr"] && payload.similarOk.length === 0
      ? Effect.fail(new DaemonContract.SimilarSubscriptions({ similar: [existing] }))
      : Effect.succeed({
        ...existing,
        id: Ids.SubscriptionId.make("sub_9q2m"),
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
      connector: "github-pr",
      subject: "acme/app#123",
      why: { _tag: "Events" as const },
      pending: [
        { number: 4, type: "checks.failed", summary: "build and e2e failed" },
        { number: 5, type: "review.submitted", summary: "alice requested changes" }
      ]
    }),
  Pause: notFaked,
  Resume: ({ id }) =>
    id === "sub_full"
      ? Effect.fail(new DaemonContract.BacklogOverLimit({ pending: 3, limit: 20, through: 27, reason: "age" }))
      : Effect.succeed({
      ...existing,
      id,
      wakeTarget: { harness: id === "sub_cc" ? "claude-code" as const : "t3" as const, sessionId: "s-1" }
    }),
  Retarget: notFaked,
  Cancel: notFaked,
  SetEventAlerts: ({ id, eventAlerts }) =>
    id === existing.id
      ? Effect.succeed({ ...existing, eventAlerts })
      : Effect.fail(new DaemonContract.HumanRequired({ subscription: id }))
})

export const inMemory = Layer.succeed(AgentClient.AgentClient, {
  connect: RpcTest.makeClient(DaemonContract.AgentGroup).pipe(Effect.provide(handlers))
})

export const mcpClient = (agentClient: Layer.Layer<AgentClient.AgentClient>) =>
  McpTest.makeClient(
    McpServer.toolkit(AgentTools.toolkit).pipe(Layer.provide(AgentTools.handlers), Layer.provide(agentClient)),
    { protocols: [McpProtocol.v2025_11_25] }
  )

export const subscribeInput = { connector: "github-pr", parameters: { pr: "acme/app#123" }, intent: "review comments" }
