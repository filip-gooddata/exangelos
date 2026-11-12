import { BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Ids } from "@exangelos/domain"
import { DaemonServer } from "@exangelos/daemon-client"
import { Effect, Layer, Option, Result, Schedule } from "effect"
import { RpcServer } from "effect/rpc"
import { Socket } from "effect/socket"
import { mkdtempSync, rmSync } from "node:fs"
import { DaemonClient } from "../src/index.ts"
import { plugin, subscription } from "./fixtures.ts"

const unused = () => Effect.die("not served in this test")

const handlers = (listDies: boolean, plugins: ReadonlyArray<ReturnType<typeof plugin>>) => DaemonContract.DaemonContract.toLayer({
  ServiceStatus: (_, { headers }) =>
    Effect.succeed({
      version: Option.isSome(SessionHeaders.fromHeaders(headers)) ? "agent" : "you",
      startMethod: "foreground"
    }),
  ListPlugins: () => Effect.succeed(plugins),
  List: () => listDies ? Effect.die("NotImplemented: List") : Effect.succeed([subscription()]),
  Subscribe: unused,
  Update: unused,
  Show: unused,
  Events: unused,
  Ack: unused,
  Wait: unused,
  Pause: unused,
  Resume: unused,
  Retarget: unused,
  Cancel: unused,
  ImportPlugin: unused,
  EnablePlugin: unused,
  DisablePlugin: unused,
  RemovePlugin: unused,
  ConfigurePlugin: unused,
  DevLink: unused,
  DevUnlink: unused,
  GetSettings: unused,
  SetSettings: unused
})

const daemon = (path: string, listDies = false, plugins = [plugin()]) =>
  RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(Layer.provide(handlers(listDies, plugins)), Layer.provide(DaemonServer.layer(path)))

const client = (path: string) =>
  DaemonClient.layer.pipe(Layer.provide(Layer.effect(Socket.Socket, BunSocket.makeNet({ path }))))

const withHome = <A, E, R>(use: (socketPath: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync("/tmp/xg-tray-")),
    (home) => use(`${home}/daemon.sock`),
    (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true }))
  )

describe("daemon client over a unix socket", () => {
  it.live("loads subscriptions and plugins and calls as you", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const loaded = yield* DaemonClient.snapshot
        expect(Result.getOrThrow(loaded.subscriptions).map((s) => s.id)).toEqual(["sub_7f3k"])
        expect(Result.getOrThrow(loaded.plugins).map((p) => p.name)).toEqual(["github-pr"])
        expect((yield* (yield* DaemonClient.DaemonClient).ServiceStatus()).version).toBe("you")
      }).pipe(Effect.provide(client(path).pipe(Layer.provideMerge(daemon(path)))))
    ))

  it.live("fails as not running without a daemon and loads once one starts", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const before = yield* Effect.flip(DaemonClient.snapshot)
        expect(before._tag).toBe("DaemonNotRunning")
        yield* Layer.build(daemon(path))
        const after = yield* DaemonClient.snapshot.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }))
        expect(Result.getOrThrow(after.plugins)).toHaveLength(1)
      }).pipe(Effect.provide(client(path)), Effect.scoped)
    ))
  it.live("fails only the section whose call the daemon answers with a defect", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const loaded = yield* DaemonClient.snapshot
        expect(Result.isFailure(loaded.subscriptions)).toBe(true)
        expect(Result.getOrThrow(loaded.plugins)).toHaveLength(2)
        expect(Result.getOrThrow(loaded.trustAlerts).map((alert) => alert._tag)).toEqual(["WaitsForEnable", "DigestMismatch"])
      }).pipe(Effect.provide(client(path).pipe(Layer.provideMerge(daemon(path, true, [
        plugin({ name: Ids.PluginName.make("new"), trust: "inert" }),
        plugin({ name: Ids.PluginName.make("official"), trust: "inert", origin: { _tag: "Official", version: "1" } })
      ])))))
    ))
})
