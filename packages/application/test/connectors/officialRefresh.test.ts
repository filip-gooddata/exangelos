import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { Connector } from "@exangelos/domain"
import {
  ConnectorAccess,
  ConnectorDirectory,
  disableConnector,
  enableConnector,
  importConnector,
  layerConnectors,
  OfficialConnectorSource,
  removeConnector,
  SubscriptionRepository
} from "@exangelos/application"
import {
  layerAlertSink,
  layerConnectorFiles,
  layerConnectorRuntime,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  ConnectorFilesFake,
  ConnectorRuntimeFake,
  connectorRoot
} from "@exangelos/application/testing"
import {
  activeSubscription,
  catalogue,
  connectorOf,
  installed,
  known,
  name,
  officialDigest,
  settle,
  storeConnector,
  you
} from "./harness.ts"

const ports = Layer.mergeAll(
  layerRepositories,
  layerConnectorRuntime,
  layerConnectorFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)

/** One daemon run over ports seeded beforehand, as an upgraded binary finds them. */
const daemonRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(Layer.build(layerConnectors), (context) => Effect.provide(effect, context)))

const github = name("github-pr")
const oldFiles = { ...installed("github-pr", "sha256-old"), version: "0.9.0" }

const stored = (overrides: Partial<Connector.Connector> = {}): Connector.Connector => ({
  name: github,
  version: "0.9.0",
  origin: { _tag: "Official", version: "0.9.0" },
  digest: "sha256-old",
  trust: "enabled",
  configuration: { _tag: "Set" },
  process: "stopped",
  ...overrides
})

const seed = (connector: Connector.Connector, script: Parameters<ConnectorRuntimeFake["Service"]["define"]>[1] = { catalogue: catalogue() }) =>
  Effect.gen(function*() {
    yield* (yield* ConnectorRuntimeFake).define(github, script)
    yield* (yield* ConnectorFilesFake).put(oldFiles)
    yield* storeConnector(connector)
  })

const filesDigest = Effect.flatMap(ConnectorDirectory.ConnectorDirectory, (d) => d.read(`${connectorRoot}/github-pr`)).pipe(
  Effect.map((files) => files.digest)
)

describe("an official connector the upgraded binary carries in another version", () => {
  it.effect("is replaced at daemon start, keeping trust, configuration and subscription cursors", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())
        yield* activeSubscription("github-pr", "sub_one", "cursor-7")
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({
          version: "1.0.0",
          digest: officialDigest,
          origin: { _tag: "Official", version: "1.0.0" },
          trust: "enabled",
          configuration: { _tag: "Set" }
        })
        expect(yield* filesDigest).toBe(officialDigest)
        const subscription = yield* Effect.flatMap(SubscriptionRepository.SubscriptionRepository, (r) => r.list({ connector: github }))
        expect(subscription.map((s) => s.cursor)).toEqual(["cursor-7"])
      }),
      ports
    ))

  it.effect("is replaced at daemon start when the installed copy rejected its configuration, which the new one accepts", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(
          stored({ catalogue: catalogue(), configuration: { _tag: "Rejected", reason: "HTTP 401" } }),
          { catalogue: catalogue(), start: { _tag: "Slow", duration: "1 second" } }
        )
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("1 second")
          yield* settle
          yield* TestClock.adjust("1 second")
          yield* settle
        }))

        expect(yield* connectorOf("github-pr")).toMatchObject({
          version: "1.0.0",
          digest: officialDigest,
          configuration: { _tag: "Set" }
        })
        expect(yield* filesDigest).toBe(officialDigest)
      }),
      ports
    ))

  it.effect("is replaced when the new version with a rejected configuration starts only on a retry", () =>
    Effect.provide(
      Effect.gen(function*() {
        const runtime = yield* ConnectorRuntimeFake
        yield* seed(
          stored({ catalogue: catalogue(), configuration: { _tag: "Rejected", reason: "HTTP 401" } }),
          { catalogue: catalogue(), start: { _tag: "Fail", reason: "spawn failed" } }
        )
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* runtime.define(github, { catalogue: catalogue() })
          yield* TestClock.adjust("2 seconds")
          yield* settle
        }))

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", configuration: { _tag: "Set" } })
      }),
      ports
    ))

  it.effect("is left alone when the installed copy is already the carried one", () =>
    Effect.provide(
      Effect.gen(function*() {
        const current = stored({ version: "1.0.0", origin: { _tag: "Official", version: "1.0.0" }, digest: officialDigest })
        yield* seed(current)
        yield* (yield* ConnectorFilesFake).put(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", digest: officialDigest, trust: "enabled" })
        expect(yield* (yield* ConnectorFilesFake).replacements).toBe(0)
      }),
      ports
    ))

  it.effect("keeps the installed copy when the new archive's digest does not match", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", "sha256-tampered"))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old", trust: "enabled" })
        expect(yield* filesDigest).toBe("sha256-old")
        expect((yield* (yield* ConnectorRuntimeFake).launches(github)).length).toBeGreaterThan(0)
      }),
      ports
    ))

  it.effect("puts the installed copy back when the new version does not start", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Incompatible", version: 9, supported: [1] } })
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old", origin: { version: "0.9.0" } })
        expect(yield* filesDigest).toBe("sha256-old")
      }),
      ports
    ))

  it.effect("puts the installed copy back when the new version is still not running at the start timeout", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Hang" } })
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
        }))

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old" })
        expect(yield* filesDigest).toBe("sha256-old")
      }),
      ports
    ))

  it.effect("puts the installed copy back when the daemon stops while the new version starts", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Hang" } })
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old" })
        expect(yield* filesDigest).toBe("sha256-old")
      }),
      ports
    ))

  it.effect("puts the installed copy back when the daemon stops right after the swap", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* Effect.asVoid(files.holdReplace("after"))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old" })
        expect(yield* filesDigest).toBe("sha256-old")
      }),
      ports
    ))

  it.effect("leaves no files behind when a copy that was missing is replaced and the new version does not start", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* (yield* ConnectorRuntimeFake).define(github, { catalogue: catalogue(), start: { _tag: "Hang" } })
        yield* storeConnector(stored())
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
        }))

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old" })
        expect(yield* Effect.exit(filesDigest)).toMatchObject({ _tag: "Failure" })
      }),
      ports
    ))

  it.effect("lets another connector be disabled while a refresh waits on its download", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())
        yield* (yield* ConnectorRuntimeFake).define(name("acme"), { catalogue: catalogue() })
        yield* (yield* ConnectorFilesFake).put(installed("acme"))
        yield* storeConnector({ ...stored(), name: name("acme"), origin: { _tag: "Directory", path: "/src/acme" }, digest: "sha256-a" })
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        const release = yield* files.holdReplace("before")

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* disableConnector(you, name("acme"))
          expect(yield* connectorOf("acme")).toMatchObject({ trust: "inert" })
          yield* release
          yield* settle
        }))
      }),
      ports
    ))

  it.effect("puts back a copy a failed rollback kept on the next daemon start, then tries again", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Hang" } })
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* files.failRestores(1)

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
        }))
        expect(yield* connectorOf("github-pr")).toMatchObject({ digest: officialDigest })
        expect(yield* filesDigest).toBe(officialDigest)

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
        }))

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old", origin: { version: "0.9.0" } })
        expect(yield* filesDigest).toBe("sha256-old")
        expect(yield* files.replacements).toBe(2)
      }),
      ports
    ))

  it.effect("leaves a connector imported after a failed rollback alone", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Hang" } })
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* files.failRestores(1)
        const source = { _tag: "Directory", path: "/src/github-pr" } as const
        yield* files.offer(source, installed("github-pr", "sha256-imported"))

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
          yield* importConnector(you, source)
        }))
        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ digest: "sha256-imported", origin: { _tag: "Directory" } })
        expect(yield* filesDigest).toBe("sha256-imported")
      }),
      ports
    ))

  it.effect("finishes a failed rollback over a copy that was missing, then tries the release again", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* (yield* ConnectorRuntimeFake).define(github, { catalogue: catalogue(), start: { _tag: "Hang" } })
        yield* storeConnector(stored())
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* files.failRestores(1)

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
        }))
        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "0.9.0", digest: "sha256-old", origin: { version: "0.9.0" } })
        expect(yield* Effect.exit(filesDigest)).toMatchObject({ _tag: "Failure" })
        expect(yield* files.replacements).toBe(2)
      }),
      ports
    ))

  it.effect("keeps the record's earlier release on a rollback, so the release is tried again", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored({ version: "1.0.0", digest: officialDigest }))
        yield* (yield* ConnectorFilesFake).put(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", origin: { _tag: "Official", version: "0.9.0" } })
      }),
      ports
    ))

  it.effect("drops what a failed rollback kept once the connector is removed and fetched again", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored(), { catalogue: catalogue(), start: { _tag: "Hang" } })
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* files.failRestores(1)
        const official = known[0]!

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("31 seconds")
          yield* settle
          yield* removeConnector(you, github)
          yield* Effect.forkChild(
            Effect.exit((yield* ConnectorAccess.ConnectorAccess).describe(you, github, { parameters: { name: "acme/app#1" }, main: Option.none() }))
          )
          yield* settle
          expect(yield* (yield* OfficialConnectorSource.OfficialConnectorSource).kept(official)).toEqual(Option.none())
        }))
      }),
      ports
    ))

  it.effect("puts the earlier copy back and tries again when a refresh cannot let it go", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        yield* files.failDiscards(1)

        yield* daemonRun(settle)
        expect(yield* (yield* OfficialConnectorSource.OfficialConnectorSource).kept(known[0]!)).toMatchObject(
          Option.some({ version: "0.9.0", digest: "sha256-old" })
        )

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", digest: officialDigest, trust: "enabled" })
        expect(yield* filesDigest).toBe(officialDigest)
        expect(yield* files.replacements).toBe(2)
        expect(yield* (yield* OfficialConnectorSource.OfficialConnectorSource).kept(known[0]!)).toEqual(Option.none())
      }),
      ports
    ))

  it.effect("refreshes a disabled connector without enabling or starting it", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored({ trust: "inert" }))
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", digest: officialDigest, trust: "inert" })
        expect(yield* (yield* ConnectorRuntimeFake).launches(github)).toHaveLength(0)
      }),
      ports
    ))

  it.effect("holds an enable until a refresh in flight ends, then judges it against the new digest", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored({ trust: "inert" }))
        const files = yield* ConnectorFilesFake
        yield* files.publish(installed("github-pr", officialDigest))
        const release = yield* files.holdReplace("before")

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          const enabling = yield* Effect.forkChild(Effect.exit(enableConnector(you, github, "sha256-old")))
          yield* settle
          expect(yield* connectorOf("github-pr")).toMatchObject({ trust: "inert", digest: "sha256-old" })

          yield* release
          const enabled = yield* Fiber.join(enabling)
          expect(Exit.isFailure(enabled)).toBe(true)
          expect(yield* connectorOf("github-pr")).toMatchObject({ trust: "inert", digest: officialDigest })
        }))
      }),
      ports
    ))

  it.effect("never touches an imported connector of the same name", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored({ origin: { _tag: "Directory", path: "/src/github-pr" } }))
        yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

        yield* daemonRun(settle)

        expect(yield* connectorOf("github-pr")).toMatchObject({ digest: "sha256-old", origin: { _tag: "Directory" } })
        expect(yield* filesDigest).toBe("sha256-old")
      }),
      ports
    ))

  it.effect("tries again on use once the retry window has passed after a failed start", () =>
    Effect.provide(
      Effect.gen(function*() {
        yield* seed(stored())

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          expect(yield* connectorOf("github-pr")).toMatchObject({ digest: "sha256-old" })

          yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))
          yield* TestClock.adjust("11 minutes")
          yield* (yield* ConnectorAccess.ConnectorAccess).describe(you, github, { parameters: { name: "acme/app#1" }, main: Option.none() })

          expect(yield* connectorOf("github-pr")).toMatchObject({ version: "1.0.0", digest: officialDigest, trust: "enabled" })
        }))
      }),
      ports
    ))
})
