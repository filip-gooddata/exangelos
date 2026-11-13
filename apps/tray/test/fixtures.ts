import { type Catalogue, type Event, Ids, Limits, type Plugin, type Session, type Settings, type Subscription, type Wake } from "@exangelos/domain"
import { DateTime, Result } from "effect"
import type { Detail } from "../src/daemon/DaemonClient.ts"
import * as Panel from "../src/state/Panel.ts"
import { PanelState } from "../src/state/Panel.ts"

const start = DateTime.makeUnsafe("2026-11-01T10:00:00Z")

export const plugin = (overrides: Partial<Plugin.Plugin> = {}): Plugin.Plugin => ({
  name: Ids.PluginName.make("github-pr"),
  version: "1.0.0",
  origin: { _tag: "ArchiveFile", path: "/tmp/github-pr.tgz" },
  digest: "sha256-a",
  trust: "enabled",
  configuration: { _tag: "Set" },
  process: "running",
  ...overrides
})

export const subscription = (overrides: Partial<Subscription.Subscription> = {}): Subscription.Subscription => ({
  id: Ids.SubscriptionId.make("sub_7f3k"),
  plugin: Ids.PluginName.make("github-pr"),
  parameters: { pr: "acme/app#123" },
  subject: "acme/app#123",
  label: "acme/app#123",
  intent: "Fix the build when CI fails",
  wakeTarget: { harness: "t3", sessionId: "thread-alice" },
  createdAt: start,
  expiresAt: DateTime.add(start, { days: 7 }),
  state: { _tag: "Active" },
  stateSince: start,
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false,
  ...overrides
})

/** The ui-brief sample data, seen at a fixed `now`. */
const nowAt = DateTime.makeUnsafe("2026-11-13T12:00:00Z")
export const now = DateTime.toEpochMillis(nowAt)

const ago = (parts: Partial<DateTime.DateTime.PartsForMath>) => DateTime.subtract(nowAt, parts)
const ahead = (parts: Partial<DateTime.DateTime.PartsForMath>) => DateTime.add(nowAt, parts)

const t3: Session.Session = { harness: "t3", sessionId: "Fix flaky checkout test" }
const claude: Session.Session = { harness: "claude-code", sessionId: "api-gateway" }
const codex: Session.Session = { harness: "codex", sessionId: "Docs refresh" }

const names = {
  github: Ids.PluginName.make("github-pr"),
  jira: Ids.PluginName.make("jira"),
  files: Ids.PluginName.make("file-watch"),
  linear: Ids.PluginName.make("linear-issues"),
  mine: Ids.PluginName.make("my-plugin")
}

const sample = (
  id: string,
  plugin: Ids.PluginName,
  subject: string,
  label: string,
  intent: string,
  wakeTarget: Session.Session | undefined,
  rest: Partial<Subscription.Subscription> = {}
): Subscription.Subscription => ({
  id: Ids.SubscriptionId.make(id),
  plugin,
  parameters: { subject },
  subject,
  label,
  intent,
  ...(wakeTarget === undefined ? {} : { wakeTarget }),
  createdAt: ago({ days: 1 }),
  expiresAt: ahead({ days: 6 }),
  state: { _tag: "Active" },
  stateSince: ago({ days: 1 }),
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false,
  ...rest
})

const open = [
  sample("sub_7f3k", names.github, "acme/app#123", "Fix flaky checkout test", "Waiting on checks and review for the checkout test fix.", t3, {
    eventTypes: [Ids.EventType.make("checks.failed"), Ids.EventType.make("review.submitted")],
    lastNumber: 5,
    ackedThrough: 3,
    eventAlerts: true
  }),
  sample("sub_2m9x", names.github, "acme/app#131", "Bump vitest to 4", "Merge the vitest bump once checks pass.", t3, {
    expiresAt: ahead({ days: 4 }),
    lastNumber: 2,
    ackedThrough: 2
  }),
  sample("sub_q41d", names.jira, "OPS-231", "Rotate staging certificates", "Start the certificate rollout when OPS-231 is approved.", claude),
  sample("sub_c8ta", names.files, "~/code/api-gateway/dist/**", "Build output", "Rerun the contract tests when the build output changes.", claude, {
    state: { _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } },
    stateSince: ago({ hours: 1 }),
    lastNumber: 20
  }),
  sample("sub_h5wn", names.github, "acme/docs#48", "Refresh install guide", "Answer review comments on the install guide.", codex, {
    state: { _tag: "Expired" },
    stateSince: ago({ days: 1 }),
    expiresAt: ago({ days: 1 })
  }),
  sample("sub_e0pz", names.jira, "OPS-198", "Flaky deploy alarm", "Close the incident notes when the alarm ticket is done.", undefined, {
    lastNumber: 3,
    ackedThrough: 2
  })
]

const closed = [
  sample("sub_a3lr", names.github, "acme/app#117", "Follow-up rebase", "Rebase the follow-up branch after this merges.", t3, {
    state: { _tag: "Ended", reason: { _tag: "Plugin", reason: "pull request merged" } },
    stateSince: ago({ days: 2 })
  }),
  sample("sub_k7vy", names.files, "~/notes/**", "Notes", "Index new notes.", undefined, {
    state: { _tag: "Cancelled", actor: { _tag: "You" } },
    stateSince: ago({ days: 5 })
  })
]

const subscriptionId = (id: string) => Ids.SubscriptionId.make(id)

const event = (subscription: string, number: number, type: string, summary: string, at: DateTime.Utc): Event.Event => ({
  id: Ids.EventId.make(`evt_${subscription.slice(4)}${number}`),
  subscription: subscriptionId(subscription),
  number: Ids.EventNumber.make(number),
  type: Ids.EventType.make(type),
  occurredAt: at,
  receivedAt: at,
  summary,
  payload: {},
  dedupeKey: `${subscription}-${number}`
})

const change = (kind: Subscription.ChangeKind, at: DateTime.Utc, detail?: string): Subscription.Change => ({
  subscription: subscriptionId("sub_7f3k"),
  kind,
  actor: { _tag: "Session", session: t3 },
  at,
  ...(detail === undefined ? {} : { detail })
})

const wake = (subscription: string, state: Wake.WakeState, at: DateTime.Utc, attempts: Wake.Attempts, reason: Wake.WakeReason = "events", through = 0): Wake.Wake => ({
  id: Ids.WakeId.make(`wake_${subscription.slice(4)}`),
  subscription: subscriptionId(subscription),
  reason,
  through: Ids.AckedThrough.make(through),
  state,
  attempts,
  createdAt: at
})

const details = (codexReachable: boolean): ReadonlyArray<Detail> => {
  const find = (id: string) => open.find((s) => s.id === id) ?? closed.find((s) => s.id === id)!
  const quietDetail = (id: string): Detail => ({ subscription: find(id), events: [], wakes: [], changes: [] })
  return [
    {
      subscription: find("sub_7f3k"),
      events: [
        event("sub_7f3k", 4, "checks.failed", "build and e2e failed", ago({ minutes: 6 })),
        event("sub_7f3k", 5, "review.submitted", "alice requested changes", ago({ minutes: 2 }))
      ],
      wakes: [wake("sub_7f3k", "delivered", ago({ minutes: 2 }), { count: 1 }, "events", 5)],
      changes: [
        change("ack", ago({ hours: 1 }), "through #3"),
        change("update", ago({ days: 1 }), "event types"),
        change("create", ago({ days: 1 }))
      ]
    },
    { ...quietDetail("sub_2m9x"), events: [event("sub_2m9x", 2, "checks.passed", "all checks passed", ago({ hours: 3 }))] },
    quietDetail("sub_q41d"),
    quietDetail("sub_c8ta"),
    {
      ...quietDetail("sub_h5wn"),
      wakes: [
        codexReachable
          ? wake("sub_h5wn", "delivered", ago({ days: 1 }), { count: 1 }, "expired")
          : wake("sub_h5wn", "waiting", ago({ minutes: 42 }), {
            count: 7,
            lastError: "session unreachable",
            nextAttemptAt: ahead({ minutes: 9 })
          }, "expired")
      ]
    },
    { ...quietDetail("sub_e0pz"), events: [event("sub_e0pz", 3, "status.changed", "In review to Done", ago({ minutes: 40 }))] },
    quietDetail("sub_a3lr"),
    quietDetail("sub_k7vy")
  ]
}

const hexDigest = (seed: string): string =>
  Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) * (i + 7)) % 16]).join("")

const official = (name: Ids.PluginName, version: string, rest: Partial<Plugin.Plugin> = {}): Plugin.Plugin => ({
  name,
  version,
  origin: { _tag: "Official", version },
  digest: hexDigest(name),
  trust: "enabled",
  configuration: { _tag: "Set" },
  process: "running",
  ...rest
})

const jiraCatalogue: Catalogue.Catalogue = {
  eventTypes: [{ type: Ids.EventType.make("status.changed"), description: "The issue moved to another status", payload: {} }],
  parameters: { main: "issue", schema: {} },
  configuration: [
    { _tag: "Text", key: "siteUrl", label: "Site URL", required: true, secretDestination: false },
    { _tag: "Text", key: "email", label: "Email", required: true, secretDestination: false },
    { _tag: "Secret", key: "apiToken", label: "API token", required: true }
  ]
}

/** An inert third-party plugin that waits for you to enable it. */
export const inertPlugin: Plugin.Plugin = {
  name: names.linear,
  version: "0.3.1",
  origin: { _tag: "GitRepository", url: "https://github.com/example/exangelos-linear", ref: "v0.3.1" },
  digest: "9c1f04ab7d52e8a1c3f6b09d4e7a2c5f81b3d6e09a4c7f2b5e8d1a3c6f9be27a",
  trust: "inert",
  configuration: { _tag: "Missing" },
  process: "stopped"
}

const plugins = (needsYou: boolean): ReadonlyArray<Plugin.Plugin> => [
  official(names.github, "1.2.0"),
  needsYou
    ? official(names.jira, "1.0.3", {
      catalogue: jiraCatalogue,
      configuration: { _tag: "Rejected", reason: "401 Unauthorized from acme.atlassian.net" },
      configuredBy: { _tag: "You" },
      unavailableSince: ago({ minutes: 25 })
    })
    : official(names.jira, "1.0.3", { catalogue: jiraCatalogue, configuredBy: { _tag: "You" } }),
  official(names.files, "1.0.0", { configuration: { _tag: "Set" } }),
  ...(needsYou ? [inertPlugin] : []),
  {
    name: names.mine,
    version: "0.0.1",
    origin: { _tag: "DevLink", path: "~/code/my-plugin" },
    digest: hexDigest("my-plugin"),
    trust: "dev",
    configuration: { _tag: "Set" },
    process: "running"
  }
]

const settings: Settings.Settings = { eventAlerts: true, limits: Limits.defaults }

const ready = (needsYou: boolean): PanelState => {
  const installed = plugins(needsYou)
  return PanelState.Ready({
    subscriptions: Result.succeed([...open, ...closed]),
    details: Result.succeed(details(!needsYou)),
    plugins: Result.succeed(installed),
    needsYou: Result.succeed(
      Panel.needsYou(installed, needsYou ? [{ _tag: "WaitsForEnable", plugin: names.linear }] : [])
    ),
    settings: Result.succeed(settings),
    status: Result.succeed({ version: "0.1.0", startMethod: "launch-agent" })
  })
}

/** The sample data with nothing that needs you: jira healthy, linear-issues not imported, the Codex session reachable. */
export const quiet: PanelState = ready(false)

/** The sample data with both needs-you items: jira's credentials rejected and linear-issues waiting to be enabled. */
export const needsYou: PanelState = ready(true)

/** The daemon runs and no agent has subscribed yet. */
export const empty: PanelState = PanelState.Ready({
  subscriptions: Result.succeed([]),
  details: Result.succeed([]),
  plugins: Result.succeed([official(names.github, "1.2.0")]),
  needsYou: Result.succeed([]),
  settings: Result.succeed(settings),
  status: Result.succeed({ version: "0.1.0", startMethod: "launch-agent" })
})
