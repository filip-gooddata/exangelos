import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configureConnector, devLink, layerConnectors, ConnectorAccess } from "@exangelos/application"
import {
  layerAlertSink,
  layerConnectorFiles,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  ConnectorFilesFake,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"
// Imported by path: a workspace dependency on the runtime adapter would make a cycle, since it depends on this package.
import { StdioConnectorRuntime } from "../../../../adapters/connector-runtime/src/index.ts"
import { activeSubscription, installed, known, name, connectorOf, you } from "./harness.ts"

const templateDirectory = fileURLToPath(new URL("../../../../connectors/template", import.meta.url))

const runtime = StdioConnectorRuntime.layer({
  commandFor: (launch) => ({ command: "bun", args: [resolve(launch.directory, launch.entry.path)], env: {} })
}).pipe(Layer.provide(BunServices.layer))

const layer = layerConnectors.pipe(Layer.provideMerge(Layer.mergeAll(
  layerRepositories,
  runtime,
  layerConnectorFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)))

const template = name("template")

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (a: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(done, () => "not yet"),
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeout("10 seconds")
  )

describe("connector supervision over the real runtime", () => {
  it.live("resumes a Watch of the template connector after its stored cursor", () =>
    Effect.gen(function*() {
      yield* (yield* ConnectorFilesFake).put({
        ...installed("template", "sha256-template", templateDirectory),
        entry: { _tag: "Bundle", path: "src/main.ts" }
      })
      yield* devLink(you, templateDirectory)
      yield* until(connectorOf("template"), (connector) => connector.catalogue !== undefined)
      yield* configureConnector(you, template, { token: "secret" })

      const intake = yield* SubscriptionIntakeFake
      const subscription = yield* activeSubscription("template", "sub_resume", "2", { ticks: 4 })
      yield* (yield* ConnectorAccess.ConnectorAccess).watch(subscription)
      const items = yield* until(intake.ingested(subscription), (all) => all.at(-1)?._tag === "End")

      expect(items).toHaveLength(3)
      expect(items).toMatchObject([
        { _tag: "Event", event: { type: "tick", payload: { index: 3 }, summary: "Tick 3 of 4" }, cursor: "3" },
        { _tag: "Event", event: { type: "tick", payload: { index: 4 }, summary: "Tick 4 of 4" }, cursor: "4" },
        { _tag: "End", reason: "Emitted 4 ticks; wake window 5000 ms" }
      ])
    }).pipe(Effect.provide(layer)), 30_000)
})
