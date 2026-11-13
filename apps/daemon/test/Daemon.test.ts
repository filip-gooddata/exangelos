import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { digestDirectory } from "@exangelos/plugin-directory"
import { Ids } from "@exangelos/domain"
import { layerCommand } from "@exangelos/wake-targets"
import {
  bundledPlugin,
  eventually,
  home,
  install,
  installTemplate,
  quickWakes,
  run,
  start,
  templatePlugin,
  wakeLog
} from "./support.ts"

const session = { harness: "t3", sessionId: "daemon-test" } as const
const template = Ids.PluginName.make("template")

describe("Daemon", () => {
  it.live("wakes a subscriber through the command target, then reads, acknowledges and waits", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const wakes = Path.join(dir, "wakes.log")
      const { client } = yield* start(dir, { wakeTarget: layerCommand(wakeLog(wakes)) })
      yield* quickWakes(client)
      yield* installTemplate(client, dir)

      const woken = yield* client.Subscribe({
        plugin: template,
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
        plugin: template,
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
        plugin: template,
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

  it.live("reopens an open watch with the wake window a settings change sets", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client } = yield* start(dir)
      const probe = yield* bundledPlugin(
        Path.join(import.meta.dirname, "fixtures/windowProbe.ts"),
        Path.join(dir, "sources"),
        "window-probe"
      )
      const imported = yield* install(client, probe, {})
      const subscription = yield* client.Subscribe({
        plugin: imported.name,
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
      expect(ended).toMatchObject({ reason: { _tag: "Plugin", reason: "wake window 1234 ms" } })
    }).pipe(Effect.scoped), 60_000)

  it.live("reports an official plugin with a changed checksum but not one the owner disabled", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const releases = Path.join(dir, "releases")
      const built = Path.join(dir, "built")
      const archive = (name: string) =>
        Effect.gen(function*() {
          const plugin = yield* templatePlugin(built, name)
          yield* Effect.promise(() => Fs.mkdir(releases, { recursive: true }))
          yield* Effect.promise((signal) =>
            run("tar", ["--no-xattrs", "-czf", Path.join(releases, `${name}-0.1.0.tar.gz`), "-C", plugin, "."], {
              env: { ...process.env, COPYFILE_DISABLE: "1" },
              signal,
              timeout: 60_000
            })
          )
          return yield* digestDirectory(plugin)
        })
      const matching = yield* archive("matching")
      yield* archive("changed")

      const { client } = yield* start(dir, {
        officialPlugins: [
          { name: "matching", version: "0.1.0", digest: matching },
          { name: "changed", version: "0.1.0", digest: "0".repeat(64) }
        ],
        releaseUrl: `file://${releases}`
      })
      const fetch = (plugin: string) =>
        client.Subscribe({
          plugin: Ids.PluginName.make(plugin),
          parameters: { ticks: 1 },
          intent: "Fetch the official plugin",
          target: { _tag: "PullOnly" },
          similarOk: []
        }).pipe(Effect.ignore)
      yield* fetch("matching")
      yield* fetch("changed")
      yield* client.DisablePlugin({ name: Ids.PluginName.make("matching") })

      const plugins = yield* client.ListPlugins()
      expect(plugins.map(({ name, trust }) => ({ name, trust })).sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual([{ name: "changed", trust: "inert" }, { name: "matching", trust: "inert" }])
      expect(yield* client.ListPluginAlerts()).toEqual([{ _tag: "DigestMismatch", plugin: "changed" }])
    }).pipe(Effect.scoped), 60_000)
})

describe("Daemon errors", () => {
  it.live("refuses a session that enables a plugin", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { as, client } = yield* start(dir)
      const source = yield* templatePlugin(Path.join(dir, "sources"))
      const imported = yield* client.ImportPlugin({ source: { _tag: "Directory", path: source } })
      const agent = yield* as(session)
      const refused = yield* Effect.flip(agent.EnablePlugin({ name: imported.name, digest: imported.digest }))
      expect(refused._tag).toBe("HumanRequired")
      expect(refused).toMatchObject({ plugin: "template" })
    }).pipe(Effect.scoped), 60_000)

  it.live("names the count when resume finds the backlog over its limit", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client } = yield* start(dir)
      yield* quickWakes(client, { backlogCount: 2 })
      yield* installTemplate(client, dir)
      const subscription = yield* client.Subscribe({
        plugin: template,
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
