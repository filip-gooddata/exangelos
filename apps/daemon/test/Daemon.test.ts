import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect } from "effect"
import { digestDirectory } from "@exangelos/connector-directory"
import { Ids } from "@exangelos/domain"
import { layerCommand } from "@exangelos/wake-targets"
import {
  bundledConnector,
  eventually,
  home,
  install,
  installTemplate,
  quickWakes,
  run,
  start,
  templateConnector,
  wakeLog
} from "./support.ts"

const session = { harness: "t3", sessionId: "daemon-test" } as const
const template = Ids.ConnectorName.make("template")

describe("Daemon", () => {
  it.live("wakes a subscriber through the command target, then reads, acknowledges and waits", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const wakes = Path.join(dir, "wakes.log")
      const { client } = yield* start(dir, { wakeTarget: layerCommand(wakeLog(wakes)) })
      yield* quickWakes(client)
      yield* installTemplate(client, dir)

      const woken = yield* client.Subscribe({
        connector: template,
        parameters: { ticks: 3 },
        intent: "Count three ticks",
        target: { _tag: "Session", session },
        similarOk: []
      })
      const log = yield* eventually(Effect.tryPromise(async () => {
        const text = await Fs.readFile(wakes, "utf8")
        if (!text.includes(woken.id) || !text.includes("ticks:3")) throw new Error("no wake yet")
        return text
      }))
      expect(log.split("\n")[0]).toBe(woken.id)

      const events = yield* eventually(client.Events({ id: woken.id }).pipe(
        Effect.filterOrFail((events) => events.length === 3)
      ))
      expect(events.map((event) => event.payload)).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }])
      const acknowledged = yield* client.Ack({ id: woken.id, through: events[2]!.number })
      expect(acknowledged.ackedThrough).toBe(events[2]!.number)
      expect((yield* client.Show({ id: woken.id })).subscription.ackedThrough).toBe(events[2]!.number)

      const pulled = yield* client.Subscribe({
        connector: template,
        parameters: { ticks: 2 },
        intent: "Count two ticks without a wake",
        target: { _tag: "PullOnly" },
        similarOk: [woken.id]
      })
      const content = yield* client.Wait({ id: pulled.id }).pipe(Effect.timeout(Duration.seconds(20)))
      expect(content.subscription).toBe(pulled.id)
      expect(content.pending.length).toBeGreaterThan(0)
    }).pipe(Effect.scoped), 60_000)

  it.live("keeps subscriptions and their events across a restart on the same home", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const first = yield* start(dir)
      yield* installTemplate(first.client, dir)
      const subscription = yield* first.client.Subscribe({
        connector: template,
        parameters: { ticks: 2 },
        intent: "Count two ticks",
        target: { _tag: "PullOnly" },
        similarOk: []
      })
      const before = yield* eventually(first.client.Events({ id: subscription.id }).pipe(
        Effect.filterOrFail((events) => events.length === 2)
      ))
      yield* first.stop

      const { client } = yield* start(dir)
      const shown = yield* client.Show({ id: subscription.id })
      expect(shown.subscription.id).toBe(subscription.id)
      expect(shown.events).toEqual(before)
      expect(yield* client.Events({ id: subscription.id })).toEqual(before)
    }).pipe(Effect.scoped), 60_000)

  it.live("keeps a watch waiting for its subject across a restart, without events or wakes, and its creation time", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const wakes = Path.join(dir, "wakes.log")
      const calls = Path.join(dir, "watch-calls.log")
      const first = yield* start(dir, { wakeTarget: layerCommand(wakeLog(wakes)) })
      yield* quickWakes(first.client)
      const probe = yield* bundledConnector(
        Path.join(import.meta.dirname, "fixtures/pendingProbe.ts"),
        Path.join(dir, "sources"),
        "pending-probe"
      )
      const imported = yield* install(first.client, probe, {})
      const subscription = yield* first.client.Subscribe({
        connector: imported.name,
        parameters: { log: calls },
        intent: "Wait for a subject to appear",
        target: { _tag: "Session", session },
        maxEvents: 1,
        similarOk: []
      })
      const waiting = yield* eventually(first.client.Show({ id: subscription.id }).pipe(
        Effect.filterOrFail(({ subscription }) => subscription.waiting !== undefined)
      ))
      expect(waiting.subscription).toMatchObject({ waiting: "Not in the local cache yet", cursor: "c1", state: { _tag: "Active" } })
      yield* first.stop

      const { client } = yield* start(dir, { wakeTarget: layerCommand(wakeLog(wakes)) })
      const reopened = yield* eventually(Effect.tryPromise(async () => {
        const lines = (await Fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
        if (lines.length < 2) throw new Error("not reopened yet")
        return lines
      }))
      const created = DateTime.formatIso(subscription.createdAt)
      expect(reopened).toEqual([{ cursor: null, createdAt: created }, { cursor: "c1", createdAt: created }])
      const shown = yield* client.Show({ id: subscription.id })
      expect(shown.subscription).toMatchObject({ waiting: "Not in the local cache yet", state: { _tag: "Active" }, lastNumber: 0 })
      expect(shown.events).toEqual([])
      expect(yield* Effect.promise(() => Fs.access(wakes).then(() => true, () => false))).toBe(false)
    }).pipe(Effect.scoped), 60_000)

  it.live("reopens an open watch with the wake window a settings change sets", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client } = yield* start(dir)
      const probe = yield* bundledConnector(
        Path.join(import.meta.dirname, "fixtures/windowProbe.ts"),
        Path.join(dir, "sources"),
        "window-probe"
      )
      const imported = yield* install(client, probe, {})
      const subscription = yield* client.Subscribe({
        connector: imported.name,
        parameters: { label: "probe" },
        intent: "Report the wake window",
        target: { _tag: "PullOnly" },
        similarOk: []
      })
      const [first] = yield* eventually(client.Events({ id: subscription.id }).pipe(
        Effect.filterOrFail((events) => events.length > 0)
      ))
      expect(first!.payload).toEqual({ wakeWindow: 5000 })

      yield* quickWakes(client, { wakeWindow: Duration.millis(1234) })
      const ended = yield* eventually(client.Show({ id: subscription.id }).pipe(
        Effect.map((shown) => shown.subscription.state),
        Effect.filterOrFail((state) => state._tag === "Ended")
      ))
      expect(ended).toMatchObject({ reason: { _tag: "Connector", reason: "wake window 1234 ms" } })
    }).pipe(Effect.scoped), 60_000)

  it.live("reports an official connector with a changed checksum but not one the owner disabled", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const releases = Path.join(dir, "releases")
      const built = Path.join(dir, "built")
      const archive = (name: string) =>
        Effect.gen(function*() {
          const connector = yield* templateConnector(built, name)
          yield* Effect.promise(() => Fs.mkdir(releases, { recursive: true }))
          yield* Effect.promise((signal) =>
            run("tar", ["--no-xattrs", "-czf", Path.join(releases, `${name}-0.1.0.tar.gz`), "-C", connector, "."], {
              env: { ...process.env, COPYFILE_DISABLE: "1" },
              signal,
              timeout: 60_000
            })
          )
          return yield* digestDirectory(connector)
        })
      const matching = yield* archive("matching")
      yield* archive("changed")

      const { client } = yield* start(dir, {
        officialConnectors: [
          { name: "matching", version: "0.1.0", digest: matching },
          { name: "changed", version: "0.1.0", digest: "0".repeat(64) }
        ],
        releaseUrl: `file://${releases}`
      })
      const fetch = (connector: string) =>
        client.Subscribe({
          connector: Ids.ConnectorName.make(connector),
          parameters: { ticks: 1 },
          intent: "Fetch the official connector",
          target: { _tag: "PullOnly" },
          similarOk: []
        }).pipe(Effect.ignore)
      yield* fetch("matching")
      yield* fetch("changed")
      yield* client.DisableConnector({ name: Ids.ConnectorName.make("matching") })

      const connectors = yield* client.ListConnectors()
      expect(connectors.map(({ name, trust }) => ({ name, trust })).sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual([{ name: "changed", trust: "inert" }, { name: "matching", trust: "inert" }])
      expect(yield* client.ListConnectorAlerts()).toEqual([{ _tag: "DigestMismatch", connector: "changed" }])
    }).pipe(Effect.scoped), 60_000)
})

describe("Daemon errors", () => {
  it.live("refuses a session that enables a connector", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { as, client } = yield* start(dir)
      const source = yield* templateConnector(Path.join(dir, "sources"))
      const imported = yield* client.ImportConnector({ source: { _tag: "Directory", path: source } })
      const agent = yield* as(session)
      const refused = yield* Effect.flip(agent.EnableConnector({ name: imported.name, digest: imported.digest }))
      expect(refused._tag).toBe("HumanRequired")
      expect(refused).toMatchObject({ connector: "template" })
    }).pipe(Effect.scoped), 60_000)

  it.live("refuses a session that changes settings and lets the owner change them", () =>
    Effect.gen(function*() {
      const { as, client } = yield* start(yield* home)
      const before = yield* client.GetSettings()
      const agent = yield* as(session)
      const refused = yield* Effect.flip(agent.SetSettings({ settings: { ...before, eventAlerts: !before.eventAlerts } }))
      expect(refused).toMatchObject({ _tag: "HumanRequired", settings: true })
      expect(yield* client.GetSettings()).toEqual(before)
      expect(yield* client.SetSettings({ settings: { ...before, eventAlerts: !before.eventAlerts } })).toMatchObject({ eventAlerts: !before.eventAlerts })
    }).pipe(Effect.scoped), 60_000)

  it.live("lets the owner and the creating session switch event alerts and refuses another session", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { as, client } = yield* start(dir)
      yield* installTemplate(client, dir)
      const subscription = yield* client.Subscribe({
        connector: template,
        parameters: { ticks: 1 },
        intent: "Toggle event alerts",
        target: { _tag: "PullOnly" },
        similarOk: []
      })
      const changed = yield* client.SetEventAlerts({ id: subscription.id, eventAlerts: true })
      expect(changed.eventAlerts).toBe(true)
      const agent = yield* as(session)
      const refused = yield* Effect.flip(agent.SetEventAlerts({ id: subscription.id, eventAlerts: false }))
      expect(refused).toMatchObject({ _tag: "HumanRequired", subscription: subscription.id })

      const own = yield* agent.Subscribe({
        connector: template,
        parameters: { ticks: 2 },
        intent: "Toggle my own event alerts",
        target: { _tag: "PullOnly" },
        similarOk: []
      })
      expect((yield* agent.SetEventAlerts({ id: own.id, eventAlerts: true })).eventAlerts).toBe(true)
    }).pipe(Effect.scoped), 60_000)

  it.live("names the count when resume finds the backlog over its limit", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client } = yield* start(dir)
      yield* quickWakes(client, { backlogCount: 2 })
      yield* installTemplate(client, dir)
      const subscription = yield* client.Subscribe({
        connector: template,
        parameters: { ticks: 5 },
        intent: "Overflow the backlog",
        target: { _tag: "PullOnly" },
        similarOk: []
      })
      yield* eventually(client.Show({ id: subscription.id }).pipe(
        Effect.filterOrFail((shown) => shown.subscription.state._tag === "Paused")
      ))
      const refused = yield* Effect.flip(client.Resume({ id: subscription.id }))
      expect(refused).toMatchObject({ _tag: "BacklogOverLimit", reason: "count", pending: 2, limit: 2 })
    }).pipe(Effect.scoped), 60_000)
})
