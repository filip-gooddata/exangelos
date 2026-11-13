import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { DaemonContract } from "@exangelos/contracts"
import { redact } from "../../src/connectors/redact.ts"
import {
  configureConnector,
  enableConnector,
  importConnector,
  management,
  ConnectorAccess,
  ConnectorRepository,
  ConnectorRuntime,
  SecretStore
} from "@exangelos/application"
import {
  AlertSinkFake,
  ConnectorFilesFake,
  ConnectorRuntimeFake,
  connectorRoot
} from "@exangelos/application/testing"
import {
  activeSubscription,
  catalogue,
  changeKinds,
  hostAndToken,
  installed,
  name,
  officialDigest,
  connectorOf,
  settle,
  unavailableReports,
  withConnectors,
  withConnectorsOver,
  you
} from "./harness.ts"

const source = { _tag: "Directory", path: "/src/acme" } as const

const importAcme = (configuration = hostAndToken) =>
  Effect.gen(function*() {
    yield* (yield* ConnectorRuntimeFake).define(name("acme"), { catalogue: catalogue(configuration) })
    yield* (yield* ConnectorFilesFake).offer(source, installed("acme"))
    return yield* importConnector(you, source)
  })

describe("connector trust", () => {
  it.effect("lands an import inert and starts it once you enable it", () =>
    withConnectors(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      const imported = yield* importAcme([])
      yield* settle
      expect(imported.trust).toBe("inert")
      expect(yield* runtime.launches(name("acme"))).toHaveLength(0)

      yield* enableConnector(you, name("acme"), imported.digest)
      yield* settle

      expect(yield* connectorOf("acme")).toMatchObject({ trust: "enabled", process: "running", configuration: { _tag: "Set" } })
      expect(yield* runtime.launches(name("acme"))).toHaveLength(1)
      expect(yield* changeKinds("acme")).toEqual([["import", "You"], ["enable", "You"]])
    })))

  it.effect("alerts you that an import waits to be enabled, and refuses an agent's enable", () =>
    withConnectors(Effect.gen(function*() {
      const imported = yield* importAcme([])
      expect(yield* (yield* AlertSinkFake).shown).toEqual([{ _tag: "WaitsForEnable", connector: "acme" }])

      const agent = { _tag: "Session", session: {} } as never
      const refused = yield* Effect.exit(enableConnector(agent, name("acme"), imported.digest))

      expect(Exit.isFailure(refused)).toBe(true)
      expect(yield* connectorOf("acme")).toMatchObject({ trust: "inert" })
    })))

  it.effect("returns an enabled connector to inert and stops it when its files change", () =>
    withConnectors(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      const imported = yield* importAcme([])
      yield* enableConnector(you, name("acme"), imported.digest)
      yield* settle

      yield* (yield* ConnectorFilesFake).edit(`${connectorRoot}/acme`, "sha256-b")
      yield* settle

      expect(yield* connectorOf("acme")).toMatchObject({ trust: "inert", digest: "sha256-b", process: "stopped" })
      expect(yield* runtime.openStreams(name("acme"))).toBe(0)
      expect(yield* (yield* AlertSinkFake).shown).toContainEqual(expect.objectContaining({ connector: "acme" }))
      const refused = yield* Effect.exit(enableConnector(you, name("acme"), imported.digest))
      expect(Exit.isFailure(refused)).toBe(true)
    })))
})

describe("official connectors on first use", () => {
  it.effect("fetches, enables and describes a connector whose checksum matches", () =>
    withConnectors(Effect.gen(function*() {
      yield* (yield* ConnectorRuntimeFake).define(name("github-pr"), { catalogue: catalogue() })
      yield* (yield* ConnectorFilesFake).publish(installed("github-pr", officialDigest))

      const described = yield* (yield* ConnectorAccess.ConnectorAccess).describe(you, name("github-pr"), { parameters: { name: "acme/app#1" }, main: Option.none() })

      expect(described.subject).toBe("acme/app#1")
      expect(yield* connectorOf("github-pr")).toMatchObject({ trust: "enabled", origin: { _tag: "Official" } })
      expect(yield* changeKinds("github-pr")).toEqual([["fetch", "You"]])
    })))

  it.effect("keeps a connector whose checksum does not match inert and raises the alert", () =>
    withConnectors(Effect.gen(function*() {
      yield* (yield* ConnectorRuntimeFake).define(name("github-pr"), { catalogue: catalogue() })
      yield* (yield* ConnectorFilesFake).publish(installed("github-pr", "sha256-tampered"))

      const result = yield* Effect.exit(
        (yield* ConnectorAccess.ConnectorAccess).describe(you, name("github-pr"), { parameters: { name: "acme/app#1" }, main: Option.none() })
      )

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* connectorOf("github-pr")).toMatchObject({ trust: "inert" })
      expect(yield* (yield* AlertSinkFake).shown).toHaveLength(1)
      expect(yield* (yield* ConnectorRuntimeFake).launches(name("github-pr"))).toHaveLength(0)
    })))
})

describe("configure", () => {
  const ready = Effect.gen(function*() {
    const imported = yield* importAcme()
    yield* enableConnector(you, name("acme"), imported.digest)
    yield* settle
  })

  it.effect("sends the secret to the connector's Configure call and nowhere else", () =>
    withConnectors(Effect.gen(function*() {
      yield* ready
      expect(yield* connectorOf("acme")).toMatchObject({ configuration: { _tag: "Missing" } })

      const connector = yield* configureConnector(you, name("acme"), { host: "github.com", token: "s3cret" })

      expect(connector).toMatchObject({ configuration: { _tag: "Set" }, configuredBy: you })
      expect(yield* (yield* ConnectorRuntimeFake).configured(name("acme"))).toContainEqual({ host: "github.com", token: "s3cret" })
      const repository = yield* ConnectorRepository.ConnectorRepository
      const recorded = JSON.stringify([connector, yield* repository.values(name("acme")), yield* repository.changes(name("acme"))])
      expect(recorded).not.toContain("s3cret")
    })))

  it.effect("clears the stored secrets when the host changes", () =>
    withConnectors(Effect.gen(function*() {
      yield* ready
      yield* configureConnector(you, name("acme"), { host: "github.com", token: "s3cret" })

      const connector = yield* configureConnector(you, name("acme"), { host: "ghe.example.com" })

      const token = yield* (yield* SecretStore.SecretStore).get(name("acme"), "token")
      expect(Option.map(token, Redacted.value)).toEqual(Option.none())
      expect(connector.configuration).toEqual({ _tag: "Missing" })
    })))

  it.effect("marks rejected credentials without echoing them, alerts you and suspends the subscriptions after an hour", () =>
    withConnectors(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      yield* runtime.define(name("acme"), {
        catalogue: catalogue(hostAndToken),
        configure: (values) => values.token === "bad" ? { _tag: "Rejected", reason: `401 for ${values.token}` } : { _tag: "Accepted" }
      })
      yield* (yield* ConnectorFilesFake).offer(source, installed("acme"))
      const imported = yield* importConnector(you, source)
      yield* enableConnector(you, name("acme"), imported.digest)
      yield* settle
      yield* configureConnector(you, name("acme"), { host: "github.com", token: "good" })
      yield* activeSubscription("acme", "sub_one")
      yield* (yield* ConnectorAccess.ConnectorAccess).watch("sub_one" as never)
      yield* settle
      expect(yield* runtime.openStreams(name("acme"))).toBe(1)

      const result = yield* Effect.exit(configureConnector(you, name("acme"), { token: "bad" }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* connectorOf("acme")).toMatchObject({ configuration: { _tag: "Rejected", reason: "401 for [secret]" } })
      expect(JSON.stringify(yield* (yield* AlertSinkFake).shown)).not.toContain("bad")
      expect(yield* (yield* AlertSinkFake).shown).toContainEqual(expect.objectContaining({ _tag: "CredentialsRejected" }))
      yield* settle
      expect(yield* runtime.openStreams(name("acme"))).toBe(0)
      const episode = yield* unavailableReports("acme")
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(yield* unavailableReports("acme")).toBe(episode + 1)
    })))
})

describe("a secret store that refuses a secret", () => {
  const refusing = Layer.succeed(SecretStore.SecretStore, SecretStore.SecretStore.of({
    set: (connector, _field, value) =>
      Effect.fail(new SecretStore.SecretStoreFailed({ connector, reason: `cannot store ${Redacted.value(value)}` })),
    get: () => Effect.succeedNone,
    delete: () => Effect.void
  }))

  it("leaves no fragment of overlapping secrets", () => {
    expect(redact("cannot store abcdef or xabc", ["abc", "abcdef", "xab"])).toBe("cannot store [secret] or [secret]")
  })

  it.effect("fails the configure call without the secret in the error", () =>
    withConnectorsOver(refusing)(Effect.gen(function*() {
      const imported = yield* importAcme()
      yield* enableConnector(you, name("acme"), imported.digest)
      yield* settle

      const result = yield* Effect.exit(configureConnector(you, name("acme"), { host: "github.com", token: "s3cret\u00e9" }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).toContain("ConfigurationInvalid")
      expect(JSON.stringify(result)).not.toContain("s3cret")
    })))
})

describe("credentials rejected by a stream", () => {
  it.effect("still count after you reconfigure the connector", () =>
    withConnectors(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      const imported = yield* importAcme()
      yield* enableConnector(you, name("acme"), imported.digest)
      yield* settle
      yield* configureConnector(you, name("acme"), { host: "github.com", token: "first" })
      yield* activeSubscription("acme", "sub_one")
      yield* (yield* ConnectorAccess.ConnectorAccess).watch("sub_one" as never)
      yield* settle
      yield* configureConnector(you, name("acme"), { token: "second" })
      yield* settle

      yield* runtime.fail(name("acme"), new ConnectorRuntime.CredentialsRejected({ connector: name("acme"), reason: "second expired" }))
      yield* settle

      expect(yield* connectorOf("acme")).toMatchObject({ configuration: { _tag: "Rejected", reason: "[secret] expired" } })
      expect(yield* (yield* AlertSinkFake).shown).toContainEqual(expect.objectContaining({ _tag: "CredentialsRejected" }))
    })))
})

describe("the management group", () => {
  it("offers its use cases only outside the agent group", () => {
    const agent = [...DaemonContract.AgentGroup.requests.keys()]
    expect(Object.keys(management).sort()).toEqual([...DaemonContract.ManagementGroup.requests.keys()].sort())
    expect(Object.keys(management).filter((method) => agent.includes(method))).toEqual([])
  })
})
