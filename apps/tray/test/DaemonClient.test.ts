import { BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Ids } from "@exangelos/domain"
import { DaemonServer } from "@exangelos/daemon-client"
import { TauriIpcSocket } from "@exangelos/rpc-tauri-ipc"
import { Effect, Layer, Option, Result, Schedule } from "effect"
import { RpcServer } from "effect/rpc"
import { Socket } from "effect/socket"
import { mkdtempSync, rmSync } from "node:fs"
import * as Net from "node:net"
import { DaemonClient, Host, Panel } from "../src/index.ts"
import { connector, subscription } from "./fixtures.ts"

const unused = () => Effect.die("not served in this test")

const handlers = (listDies: boolean, connectors: ReadonlyArray<ReturnType<typeof connector>>) => DaemonContract.DaemonContract.toLayer({
  ServiceStatus: (_, { headers }) =>
    Effect.succeed({
      version: Option.isSome(SessionHeaders.fromHeaders(headers)) ? "agent" : "you",
      startMethod: "foreground"
    }),
  ListConnectors: () => Effect.succeed(connectors),
  SetEventAlerts: unused,
  List: ({ all }) =>
    listDies
      ? Effect.die("NotImplemented: List")
      : Effect.succeed(all ? [subscription(), subscription({ id: Ids.SubscriptionId.make("sub_done"), state: { _tag: "Expired" } })] : [subscription()]),
  Subscribe: unused,
  Update: unused,
  Show: ({ id }) => Effect.succeed({ subscription: subscription({ id }), events: [], wakes: [], changes: [] }),
  Events: unused,
  Ack: unused,
  Wait: unused,
  Pause: ({ id }) =>
    Effect.fail(new DaemonContract.TransitionRefused({ state: { _tag: "Expired" }, message: `${id} has expired` })),
  Resume: unused,
  Retarget: unused,
  Cancel: () => Effect.die("NotImplemented: Cancel"),
  ImportConnector: unused,
  EnableConnector: unused,
  DisableConnector: unused,
  RemoveConnector: unused,
  ConfigureConnector: unused,
  DevLink: unused,
  DevUnlink: unused,
  ListConnectorAlerts: unused,
  GetSettings: unused,
  SetSettings: unused,
  SetHarness: unused,
  RemoveHarness: unused,
  SessionTitles: ({ sessions }) => Effect.succeed(sessions.map((session) => ({ ...session, title: `Title of ${session.sessionId}` })))
})

const daemon = (path: string, listDies = false, connectors = [connector()]) =>
  RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(Layer.provide(handlers(listDies, connectors)), Layer.provide(DaemonServer.layer(path)))

const client = (path: string) =>
  DaemonClient.layer.pipe(Layer.provide(Layer.effect(Socket.Socket, BunSocket.makeNet({ path }))))

const withHome = <A, E, R>(use: (socketPath: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync("/tmp/xg-tray-")),
    (home) => use(`${home}/daemon.sock`),
    (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true }))
  )

// The tray host's relay over a real unix socket; the daemon end of the first
// connection closes once the first request reaches it.
const relayDroppingFirst = (path: string): TauriIpcSocket.TauriIpc => {
  const open = new Map<number, Net.Socket>()
  let next = 1
  return {
    makeChannel: (onMessage) => onMessage,
    invoke: (command, args, options) => {
      const { connection, events } = (args ?? {}) as { connection?: number; events?: (message: unknown) => void }
      switch (command) {
        case "relay_open":
          return new Promise((resolve, reject) => {
            const id = next++
            const socket = Net.createConnection(path, () => {
              open.set(id, socket)
              resolve(id)
            })
            socket.on("data", (bytes: Buffer) => events?.(Uint8Array.from(bytes).buffer))
            const closed = () => open.delete(id) && events?.({ type: "closed" })
            socket.on("end", closed)
            socket.on("close", closed)
            socket.on("error", (error) => open.has(id) ? undefined : reject(error))
          })
        case "relay_write": {
          const id = Number(options?.headers?.["exangelos-relay-connection"])
          const socket = open.get(id)
          if (socket === undefined) return Promise.reject(`unknown connection ${id}`)
          return new Promise<void>((resolve, reject) =>
            socket.write(args as Uint8Array, (error) => {
              if (error) return reject(String(error))
              if (id === 1) socket.end()
              resolve()
            })
          )
        }
        case "relay_close":
          open.get(connection!)?.destroy()
          open.delete(connection!)
          return Promise.resolve()
      }
      return Promise.reject(command)
    }
  }
}

describe("daemon client over a unix socket", () => {
  it.live("loads subscriptions and connectors and calls as you", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const loaded = yield* DaemonClient.snapshot
        expect(Result.getOrThrow(loaded.subscriptions).map((s) => s.id)).toEqual(["sub_7f3k", "sub_done"])
        expect(Result.getOrThrow(loaded.details).map((d) => d.subscription.id)).toEqual(["sub_7f3k", "sub_done"])
        expect(Result.getOrThrow(loaded.titles)).toEqual([{ harness: "t3", sessionId: "thread-alice", title: "Title of thread-alice" }])
        expect(Result.getOrThrow(loaded.connectors).map((p) => p.name)).toEqual(["github-pr"])
        expect(Result.getFailure(loaded.settings)).toEqual(Option.some("GetSettings: not served in this test"))
        expect(Result.getOrThrow(loaded.status)).toEqual({ version: "you", startMethod: "foreground" })
        expect((yield* (yield* DaemonClient.DaemonClient).ServiceStatus()).version).toBe("you")
      }).pipe(Effect.provide(client(path).pipe(Layer.provideMerge(daemon(path)))))
    ))

  it.live("retries the calls of a connection the daemon closes and loads every section", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const loaded = yield* DaemonClient.snapshot
        expect(Result.getOrThrow(loaded.subscriptions)).toHaveLength(2)
        expect(Result.getOrThrow(loaded.details)).toHaveLength(2)
        expect(Result.getOrThrow(loaded.connectors)).toHaveLength(1)
        expect(Result.getOrThrow(loaded.status).version).toBe("you")
      }).pipe(Effect.provide(
        DaemonClient.layer.pipe(
          Layer.provide(TauriIpcSocket.layer(relayDroppingFirst(path))),
          Layer.provideMerge(daemon(path))
        )
      ))
    ))
  it.live("fails as not running without a daemon and loads once one starts", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const before = yield* Effect.flip(DaemonClient.snapshot)
        expect(before._tag).toBe("DaemonNotRunning")
        yield* Layer.build(daemon(path))
        const after = yield* DaemonClient.snapshot.pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }))
        expect(Result.getOrThrow(after.connectors)).toHaveLength(1)
      }).pipe(Effect.provide(client(path)), Effect.scoped)
    ))
  it.live("fails only the section whose call the daemon answers with a defect", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const loaded = yield* DaemonClient.snapshot
        expect(Result.isFailure(loaded.subscriptions)).toBe(true)
        expect(Result.getFailure(loaded.details)).toEqual(Result.getFailure(loaded.subscriptions))
        expect(Result.getOrThrow(loaded.connectors)).toHaveLength(2)
        expect(Result.isFailure(loaded.trustAlerts)).toBe(true)
      }).pipe(Effect.provide(client(path).pipe(Layer.provideMerge(daemon(path, true, [
        connector({ name: Ids.ConnectorName.make("new"), trust: "inert" }),
        connector({ name: Ids.ConnectorName.make("official"), trust: "inert", origin: { _tag: "Official", version: "1" } })
      ])))))
    ))
  it.live("keeps the error a refused request declares and reports a defect as a failed call", () =>
    withHome((path) =>
      Effect.gen(function*() {
        const act = Panel.act(yield* DaemonClient.DaemonClient, Effect.die("quit is not used here"))
        const id = Ids.SubscriptionId.make("sub_7f3k")
        const refused = yield* Effect.flip(act(Panel.Request.Pause({ id })))
        expect(refused).toMatchObject({ _tag: "TransitionRefused", message: "sub_7f3k has expired" })
        const failed = yield* Effect.flip(act(Panel.Request.Cancel({ id })))
        expect(failed).toMatchObject({ _tag: "CallFailed" })
        expect(failed.message).toContain("NotImplemented: Cancel")
      }).pipe(Effect.provide(client(path).pipe(Layer.provideMerge(daemon(path)))))
    ))
  it.effect("quits through the host's tray_quit command", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      yield* Host.make(async (command) => {
        calls.push(command)
      }).quit
      expect(calls).toEqual(["tray_quit"])
    }))
})
