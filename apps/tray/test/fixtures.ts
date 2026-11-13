import { Ids, type Plugin, type Subscription } from "@exangelos/domain"
import { DateTime } from "effect"

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
