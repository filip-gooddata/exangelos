import { BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Daemon } from "@exangelos/daemon"
import { Paths } from "@exangelos/paths"
import { ConfigProvider, Effect, Layer, Result } from "effect"
import { Socket } from "effect/socket"
import { mkdtempSync, rmSync } from "node:fs"
import { DaemonClient, Panel } from "../src/index.ts"

const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync("/tmp/xg-tray-")),
    use,
    (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true }))
  )

const daemon = (home: string) =>
  Daemon.layer.pipe(
    Layer.provide(Paths.layer),
    Layer.provide(BunServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ EXANGELOS_HOME: home })))
  )

const client = (home: string) =>
  DaemonClient.layer.pipe(Layer.provide(Layer.effect(Socket.Socket, BunSocket.makeNet({ path: `${home}/daemon.sock` }))))

describe("panel client against the real daemon", () => {
  it.live("loads the plugins of an empty home", () =>
    withHome((home) =>
      Effect.gen(function*() {
        const state = yield* Panel.fromLoad(DaemonClient.snapshot)
        if (state._tag !== "Ready") return expect.fail(state._tag)
        expect(Result.getOrThrow(state.plugins)).toEqual([])
        expect(Result.getOrThrow(state.needsYou)).toEqual([])
      }).pipe(Effect.provide(client(home).pipe(Layer.provideMerge(daemon(home)))))
    ))
})
