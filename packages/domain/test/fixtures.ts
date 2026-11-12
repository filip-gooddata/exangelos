import { DateTime, Duration } from "effect"
import type { Event, Plugin, Session, Subscription } from "../src/index.ts"
import { Ids, Limits } from "../src/index.ts"

export const limits = Limits.defaults

export const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

export const later = (from: DateTime.Utc, duration: Duration.Input): DateTime.Utc =>
  DateTime.addDuration(from, duration)

export const start = at("2026-11-01T10:00:00Z")

export const alice: Session.Session = { harness: "t3", sessionId: "thread-alice" }
export const bob: Session.Session = { harness: "codex", sessionId: "bob" }

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
  wakeTarget: alice,
  createdAt: start,
  expiresAt: later(start, "7 days"),
  state: { _tag: "Active" },
  stateSince: start,
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false,
  ...overrides
})

export const event = (number: number, overrides: Partial<Event.Event> = {}): Event.Event => ({
  id: Ids.EventId.make(`evt_${number}`),
  subscription: Ids.SubscriptionId.make("sub_7f3k"),
  number,
  type: Ids.EventType.make("checks.failed"),
  occurredAt: start,
  receivedAt: start,
  summary: `event ${number}`,
  payload: {},
  dedupeKey: `key-${number}`,
  ...overrides
})
