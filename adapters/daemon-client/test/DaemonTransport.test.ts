import { describe, expect, it } from "@effect/vitest"
import { ServiceManager } from "@exangelos/application"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { RpcClient, RpcServer } from "effect/rpc"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DaemonClient, DaemonServer } from "../src/index.ts"

const unused = () => Effect.die("not served in this test")

const caller = (headers: Readonly<Record<string, string | undefined>>) =>
  Option.match(SessionHeaders.fromHeaders(headers), {
    onNone: () => "you",
    onSome: (session) => `${session.harness}/${session.sessionId}`
  })

const handlers = DaemonContract.DaemonContract.toLayer({
  ServiceStatus: (_, { headers }) => Effect.succeed({ version: caller(headers), startMethod: "foreground" }),
  ListPlugins: unused,
  SetEventAlerts: unused,
  Subscribe: unused,
  Update: unused,
  List: unused,
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
  ListPluginAlerts: unused,
  GetSettings: unused,
  SetSettings: unused
})

const daemon = (path: string) =>
  RpcServer.layer(DaemonContract.DaemonContract).pipe(
    Layer.provide(handlers),
    Layer.provide(DaemonServer.layer(path))
  )

const withSocket = <A, E, R>(use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync("/tmp/xg-")),
    (dir) => use(`${dir}/daemon.sock`),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
  )

const connected = (path: string, session: Option.Option<Session.Session>) =>
  DaemonClient.layer({ path, session }).pipe(Layer.provide(daemon(path)))

const session: Session.Session = { harness: "codex", sessionId: "thread-7" }

const stopped: ServiceManager.Status = { method: "launch-agent", installed: false, running: false }

const serviceServing = (path: string, calls: Array<string>) =>
  Layer.effect(
    ServiceManager.ServiceManager,
    Effect.map(Effect.scope, (scope) => ({
      status: Effect.succeed(stopped),
      install: Effect.sync(() => void calls.push("install")),
      start: Effect.sync(() => void calls.push("start")).pipe(
        Effect.andThen(Layer.buildWithScope(daemon(path), scope)),
        Effect.orDie,
        Effect.asVoid
      )
    }))
  )

const serviceFailing = Layer.succeed(ServiceManager.ServiceManager, {
  status: Effect.succeed({ ...stopped, installed: true }),
  install: Effect.void,
  start: Effect.fail(new ServiceManager.ServiceFailed({ method: "launch-agent", reason: "launchctl bootstrap exited 5" }))
})

describe("daemon transport", () => {
  it.live("carries the session on every call", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const client = yield* DaemonClient.DaemonClient
        expect((yield* client.ServiceStatus()).version).toBe("codex/thread-7")
        expect((yield* client.ServiceStatus()).version).toBe("codex/thread-7")
      }).pipe(
        Effect.provide(connected(path, Option.some(session)))
      )
    ))

  it.live("keeps the session on a client taken out of its context", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const context = yield* Layer.build(connected(path, Option.some(session)))
        const client = Context.get(context, DaemonClient.DaemonClient)
        expect((yield* client.ServiceStatus()).version).toBe("codex/thread-7")
      }).pipe(Effect.scoped)
    ))

  it.live("sends its own session over headers the caller set", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const client = yield* DaemonClient.DaemonClient
        const other = SessionHeaders.toHeaders({ harness: "t3", sessionId: "other" })
        expect((yield* client.ServiceStatus().pipe(RpcClient.withHeaders(other))).version).toBe("codex/thread-7")
      }).pipe(
        Effect.provide(connected(path, Option.some(session)))
      )
    ))

  it.live("sends no session headers without a session", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const client = yield* DaemonClient.DaemonClient
        expect((yield* client.ServiceStatus()).version).toBe("you")
      }).pipe(
        Effect.provide(connected(path, Option.none()))
      )
    ))

  it.live("leaves the socket readable by its owner only", () =>
    withSocket((path) =>
      Effect.sync(() => expect(statSync(path).mode & 0o777).toBe(0o600)).pipe(Effect.provide(daemon(path)))
    ))

  it.live("creates the directory that holds the socket", () =>
    withSocket((path) => {
      const nested = `${dirname(path)}/state/daemon.sock`
      return Effect.sync(() => expect(statSync(nested).isSocket()).toBe(true)).pipe(Effect.provide(daemon(nested)))
    }))

  it.live("leaves only its lock file when it stops", () =>
    withSocket((path) =>
      Layer.build(daemon(path)).pipe(
        Effect.scoped,
        Effect.andThen(Effect.sync(() => expect(readdirSync(dirname(path))).toEqual(["daemon.sock.lock"])))
      )
    ))

  it.live("replaces a stale socket file", () =>
    withSocket((path) =>
      Effect.sync(() => writeFileSync(path, "")).pipe(
        Effect.andThen(
          Effect.gen(function*() {
            const client = yield* DaemonClient.DaemonClient
            expect((yield* client.ServiceStatus()).startMethod).toBe("foreground")
          }).pipe(
            Effect.provide(connected(path, Option.none()))
          )
        )
      )
    ))

  it.live("refuses to start beside a live daemon", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const exit = yield* Layer.build(daemon(path)).pipe(Effect.scoped, Effect.exit)
        expect(exit).toEqual(Exit.fail(new DaemonServer.DaemonAlreadyRunning({ path })))
      }).pipe(Effect.provide(daemon(path)))
    ))

  it.live("lets one of two daemons starting together win", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const start = Layer.build(daemon(path)).pipe(Effect.exit)
        const exits = yield* Effect.all([start, start], { concurrency: 2 })
        expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
        expect(exits.filter(Exit.isFailure)).toEqual([Exit.fail(new DaemonServer.DaemonAlreadyRunning({ path }))])
        expect(statSync(path).isSocket()).toBe(true)
      }).pipe(Effect.scoped)
    ))

  it.live("lets one of two daemons win over a stale socket file", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const start = Layer.build(daemon(path)).pipe(Effect.exit)
        for (let round = 0; round < 50; round++) {
          writeFileSync(path, "")
          const exits = yield* Effect.scoped(Effect.all([start, start], { concurrency: 2 }))
          expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
        }
      })
    ))

  it.live("reports that no daemon runs", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const exit = yield* Layer.build(DaemonClient.layer({ path, session: Option.none() })).pipe(Effect.scoped, Effect.exit)
        expect(exit).toEqual(Exit.fail(new DaemonClient.DaemonNotRunning({ path, reason: `nothing answers on ${path}` })))
      })
    ))

  it.live("starts the service when no daemon runs, then connects", () =>
    withSocket((path) => {
      const calls: Array<string> = []
      return Effect.gen(function*() {
        const client = yield* DaemonClient.DaemonClient
        expect((yield* client.ServiceStatus()).startMethod).toBe("foreground")
        expect(calls).toEqual(["install", "start"])
      }).pipe(
        Effect.provide(DaemonClient.layerStarting({ path, session: Option.none() }).pipe(
          Layer.provide(serviceServing(path, calls))
        ))
      )
    }))

  it.live("reports why starting the service failed", () =>
    withSocket((path) =>
      Effect.gen(function*() {
        const exit = yield* Layer.build(DaemonClient.layerStarting({ path, session: Option.none() })).pipe(
          Effect.provide(serviceFailing),
          Effect.scoped,
          Effect.exit
        )
        expect(exit).toEqual(
          Exit.fail(new DaemonClient.DaemonNotRunning({ path, reason: "launchctl bootstrap exited 5" }))
        )
      })
    ))
})
