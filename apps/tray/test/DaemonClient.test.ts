import { BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { DaemonServer } from "@exangelos/daemon-client"
import { Effect, Layer, Option, Schedule } from "effect"
import { RpcServer } from "effect/rpc"
import { Socket } from "effect/socket"
import { mkdtempSync, rmSync } from "node:fs"
import { DaemonClient } from "../src/index.ts"
import { plugin, subscription } from "./fixtures.ts"

const unused = () => Effect.die("not served in this test")

const handlers = DaemonContract.DaemonContract.toLayer({
  ServiceStatus: (_, { headers }) =>
    Effect.succeed({
      version: Option.isSome(SessionHeaders.fromHeaders(headers)) ? "agent" : "you",
      startMethod: "foreground"
    }),
  ListPlugins: () => Effect.succeed([plugin()]),
  List: () => Effect.succeed([subscription()]),
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

const daemon = (path: string) =>
  RpcServer.layer(DaemonContract.DaemonContract).pipe(Layer.provide(handlers), Layer.provide(DaemonServer.layer(path)))

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
        expect(loaded.subscriptions.map((s) => s.id)).toEqual(["sub_7f3k"])
        expect(loaded.plugins.map((p) => p.name)).toEqual(["github-pr"])
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
        expect(after.plugins).toHaveLength(1)
      }).pipe(Effect.provide(client(path)), Effect.scoped)
    ))
})
