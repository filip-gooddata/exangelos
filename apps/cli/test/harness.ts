/// <reference types="bun" />
import * as fs from "node:fs"
import { DateTime, Effect, Exit, FileSystem, Layer, Path, Ref, Stdio, Stream, Terminal } from "effect"
import { Command } from "effect/cli"
import { ChildProcessSpawner } from "effect/process"
import { type Rpc, type RpcGroup, RpcServer, RpcTest } from "effect/rpc"
import { TestConsole } from "effect/testing"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Catalogue, Ids, Plugin, Subscription } from "@exangelos/domain"
import { DaemonClient, DaemonServer } from "@exangelos/daemon-client"
import * as Connection from "../src/commands/Connection.ts"
import * as Root from "../src/commands/Root.ts"

const at = DateTime.makeUnsafe("2026-11-12T10:00:00Z")

export const subscription = (overrides: Partial<Subscription.Subscription> = {}): Subscription.Subscription => ({
  id: Ids.SubscriptionId.make("sub_7f3k"),
  plugin: Ids.PluginName.make("github-pr"),
  parameters: { pr: "acme/app#123" },
  subject: "acme/app#123",
  label: "acme/app#123",
  intent: "fix CI on PR 123",
  wakeTarget: { harness: "t3", sessionId: "thread-1" },
  createdAt: at,
  expiresAt: DateTime.add(at, { days: 7 }),
  state: { _tag: "Active" },
  stateSince: at,
  lastNumber: 5,
  ackedThrough: 3,
  eventAlerts: false,
  ...overrides
})

const catalogue: Catalogue.Catalogue = {
  eventTypes: [{ type: Ids.EventType.make("checks.failed"), description: "CI failed", payload: {} }],
  parameters: { main: "pr", schema: {} },
  configuration: [
    { _tag: "Text", key: "host", label: "GitHub host", required: false, secretDestination: false },
    { _tag: "Secret", key: "token", label: "GitHub token", required: true }
  ]
}

export const plugin: Plugin.Plugin = {
  name: Ids.PluginName.make("github-pr"),
  version: "1.0.0",
  origin: { _tag: "Official", version: "1.0.0" },
  digest: "sha256-abc",
  trust: "enabled",
  catalogue,
  configuration: { _tag: "Set" },
  process: "running"
}

export interface Call {
  readonly rpc: string
  readonly payload: unknown
  readonly headers: Readonly<Record<string, string | undefined>>
}

type HandlerMap = RpcGroup.HandlersFrom<RpcGroup.Rpcs<DaemonContract.DaemonContract>>

const defaults = {
  ListPlugins: () => Effect.succeed([plugin]),
  Subscribe: () => Effect.succeed(subscription()),
  Update: () => Effect.succeed(subscription()),
  List: () => Effect.succeed([subscription()]),
  Show: () => Effect.succeed({ subscription: subscription(), events: [], wakes: [], changes: [] }),
  Events: () => Effect.succeed([]),
  Ack: (payload: { readonly through: number }) => Effect.succeed(subscription({ ackedThrough: payload.through })),
  Wait: () =>
    Effect.succeed({
      subscription: Ids.SubscriptionId.make("sub_7f3k"),
      plugin: "github-pr",
      subject: "acme/app#123",
      why: { _tag: "Events" as const },
      pending: [{ number: 4, type: "checks.failed", summary: "build failed" }]
    }),
  Pause: () =>
    Effect.succeed(subscription({ state: { _tag: "Paused", reason: { _tag: "Actor", actor: { _tag: "You" } } } })),
  Resume: () => Effect.succeed(subscription()),
  Retarget: () => Effect.succeed(subscription()),
  Cancel: () => Effect.succeed(subscription({ state: { _tag: "Cancelled", actor: { _tag: "You" } } })),
  ImportPlugin: () => Effect.succeed({ ...plugin, trust: "inert" as const }),
  EnablePlugin: () => Effect.succeed(plugin),
  DisablePlugin: () => Effect.succeed({ ...plugin, trust: "inert" as const }),
  RemovePlugin: () => Effect.void,
  ConfigurePlugin: () => Effect.succeed(plugin),
  DevLink: () => Effect.succeed(plugin),
  DevUnlink: () => Effect.void,
  GetSettings: () => Effect.die("unused"),
  SetSettings: () => Effect.die("unused"),
  ServiceStatus: () => Effect.succeed({ version: "0.1.0", startMethod: "foreground" as const }),
  SetEventAlerts: () => Effect.die("unused")
} satisfies HandlerMap

export const daemonServer = (path: string) =>
  RpcServer.layer(DaemonContract.DaemonContract).pipe(
    Layer.provide(
      DaemonContract.DaemonContract.toLayer(defaults) as Layer.Layer<
        Rpc.ToHandler<RpcGroup.Rpcs<DaemonContract.DaemonContract>>
      >
    ),
    Layer.provide(DaemonServer.layer(path))
  )

const terminal = Terminal.make({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  size: Effect.die("unused"),
  readInput: Effect.die("no terminal input in tests"),
  readLine: Effect.die("no terminal input in tests"),
  display: () => Effect.void
})

const spawner = (output: string, ran: Array<string>) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      ran.push(command._tag === "StandardCommand" ? [command.command, ...command.args.map(String)].join(" ") : "piped")
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Effect.die("unused") as never,
        stdout: Stream.make(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.make(new TextEncoder().encode(output)),
        getInputFd: () => Effect.die("unused") as never,
        getOutputFd: () => Effect.die("unused") as never,
        unref: Effect.succeed(Effect.void) as never
      })
    })
  )

export interface Result {
  readonly exit: Exit.Exit<void, unknown>
  readonly stdout: string
  readonly stderr: string
  readonly calls: ReadonlyArray<Call>
  readonly ran: ReadonlyArray<string>
}

export const run = (
  argv: ReadonlyArray<string>,
  options: {
    readonly handlers?: Partial<HandlerMap>
    readonly socket?: {
      readonly path: string
      readonly env?: Readonly<Record<string, string | undefined>>
      readonly serve?: boolean
    }
    readonly commandOutput?: string
  } = {}
): Promise<Result> =>
  Effect.gen(function*() {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([])
    const ran: Array<string> = []
    const recorded = Object.fromEntries(
      Object.entries({ ...defaults, ...options.handlers }).map(([rpc, handler]) => [
        rpc,
        (payload: unknown, meta: { readonly headers: Readonly<Record<string, string | undefined>> }) =>
          Effect.andThen(
            Ref.update(calls, (all) => [...all, { rpc, payload, headers: { ...meta.headers } }]),
            (handler as (payload: unknown) => Effect.Effect<unknown, unknown>)(payload)
          )
      ])
    ) as unknown as HandlerMap
    const handlers = DaemonContract.DaemonContract.toLayer(recorded) as Layer.Layer<
      Rpc.ToHandler<RpcGroup.Rpcs<DaemonContract.DaemonContract>>
    >
    const socket = options.socket
    if (socket !== undefined && socket.serve !== false) {
      yield* Layer.build(
        RpcServer.layer(DaemonContract.DaemonContract).pipe(
          Layer.provide(handlers),
          Layer.provide(DaemonServer.layer(socket.path))
        )
      )
    }
    const client = socket === undefined
      ? Layer.succeed(
        DaemonClient.DaemonClient,
        yield* RpcTest.makeClient(DaemonContract.DaemonContract).pipe(Effect.provide(handlers))
      )
      : DaemonClient.layer({ path: socket.path, session: SessionHeaders.detect(socket.env ?? {}) })
    const environment = Layer.mergeAll(
      FileSystem.layerNoop({
        readFileString: (path) => Effect.sync(() => fs.readFileSync(path, "utf8"))
      }),
      Path.layer,
      Stdio.layerTest({}),
      Layer.succeed(Terminal.Terminal, terminal),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner(options.commandOutput ?? "", ran)),
      Connection.layer(client)
    )
    const exit = yield* Command.runWith(Root.make(), { version: "0.0.0-test" })(argv).pipe(
      Effect.provide(environment),
      Effect.exit
    )
    const lines = (all: ReadonlyArray<unknown>) => all.map((line) => String(line)).join("\n")
    return {
      exit,
      stdout: lines(yield* TestConsole.logLines),
      stderr: lines(yield* TestConsole.errorLines),
      calls: yield* Ref.get(calls),
      ran
    }
  }).pipe(Effect.provide(TestConsole.layer), Effect.scoped, Effect.runPromise)

export const callOf = (result: Result, rpc: string): Call | undefined => result.calls.find((call) => call.rpc === rpc)
