/// <reference types="bun" />
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { BunServices } from "@effect/platform-bun"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Runtime } from "effect"
import { TestConsole } from "effect/testing"
import { ServiceManager } from "@exangelos/application"
import { layerAlertSink, layerSecretStore, layerSessionTitles, layerWakeTarget } from "@exangelos/application/testing"
import { Paths } from "@exangelos/paths"
import * as Entry from "../src/Entry.ts"
import { daemonServer } from "./harness.ts"

const directory = mkdtempSync("/tmp/xng-entry-")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const pathsIn = (dir: string): Layer.Layer<Paths.Paths> =>
  Layer.succeed(
    Paths.Paths,
    Paths.Paths.of({
      configDir: dir,
      dataDir: dir,
      stateDir: dir,
      settingsFile: `${dir}/settings.json`,
      secretsFile: `${dir}/secrets.json`,
      databaseFile: `${dir}/exangelos.db`,
      connectorDir: `${dir}/connectors`,
      socketPath: `${dir}/daemon.sock`,
      logDir: dir,
      logFile: `${dir}/daemon.log`
    })
  )

const run = (
  argv: ReadonlyArray<string>,
  name: string,
  start: (socket: string) => Effect.Effect<void, ServiceManager.ServiceFailed>
) =>
  Effect.gen(function*() {
    const home = `${directory}/${name}`
    mkdirSync(home, { recursive: true })
    const socket = `${home}/daemon.sock`
    const ran: Array<string> = []
    const manager = Layer.succeed(
      ServiceManager.ServiceManager,
      ServiceManager.ServiceManager.of({
        startMethod: Effect.succeed("launch-agent"),
        status: Effect.sync(() => {
          ran.push("status")
          return { method: "launch-agent" as const, installed: false, running: false }
        }),
        install: Effect.sync(() => void ran.push("install")),
        start: Effect.andThen(Effect.sync(() => void ran.push("start")), start(socket))
      })
    )
    const exit = yield* Entry.run({
      version: "0.0.0-test",
      client: Entry.daemonClient(Option.none(), manager),
      daemon: {
        alerts: layerAlertSink,
        serviceManager: manager,
        secretStore: layerSecretStore,
        wakeTarget: layerWakeTarget,
        sessionTitles: layerSessionTitles,
        officialConnectors: [],
        releaseUrl: undefined
      }
    })(argv).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, pathsIn(home))),
      Effect.exit
    )
    let code = -1
    Runtime.defaultTeardown(exit, (exitCode) => {
      code = exitCode
    })
    return {
      code,
      ran,
      stdout: (yield* TestConsole.logLines).join("\n"),
      stderr: (yield* TestConsole.errorLines).join("\n")
    }
  })

describe("the exangelos entry", () => {
  it.effect("starts the daemon through the service manager when none answers", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const result = yield* run(["--json", "list"], "started", (socket) =>
        Layer.buildWithScope(daemonServer(socket), scope).pipe(Effect.asVoid, Effect.orDie))
      expect(result.ran).toEqual(["status", "install", "start"])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toHaveLength(1)
    }).pipe(Effect.provide(TestConsole.layer), Effect.scoped))

  it.effect("service status, as the tray runs it, installs and starts the service once and later finds it answering", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const first = yield* run(["service", "status"], "tray", (socket) =>
        Layer.buildWithScope(daemonServer(socket), scope).pipe(Effect.asVoid, Effect.orDie))
      expect(first.ran).toEqual(["status", "install", "start"])
      expect(first.code).toBe(0)
      const later = yield* run(["service", "status"], "tray", () => Effect.die("started twice"))
      expect(later.ran).toEqual([])
      expect(later.code).toBe(0)
    }).pipe(Effect.provide(TestConsole.layer), Effect.scoped))

  it.effect("prints the no-daemon text with the service's reason and exits 1 when the start fails", () =>
    Effect.gen(function*() {
      const result = yield* run(["list"], "refused", () =>
        Effect.fail(new ServiceManager.ServiceFailed({ method: "launch-agent", reason: "launchctl bootstrap refused" })))
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe(
        "No Exangelos daemon is running, and starting it failed: launchctl bootstrap refused. Run `exangelos daemon` in a terminal to start it in the foreground, then retry this command."
      )
    }).pipe(Effect.provide(TestConsole.layer)))
})
