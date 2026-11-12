import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { DaemonContract } from "@exangelos/contracts"
import {
  configurePlugin,
  enablePlugin,
  importPlugin,
  management,
  PluginAccess,
  PluginRepository,
  SecretStore
} from "@exangelos/application"
import {
  AlertSinkFake,
  PluginFilesFake,
  PluginRuntimeFake,
  pluginRoot,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"
import {
  activeSubscription,
  catalogue,
  changeKinds,
  hostAndToken,
  installed,
  name,
  officialDigest,
  pluginOf,
  settle,
  withPlugins,
  you
} from "./harness.ts"

const source = { _tag: "Directory", path: "/src/acme" } as const

const importAcme = (configuration = hostAndToken) =>
  Effect.gen(function*() {
    yield* (yield* PluginRuntimeFake).define(name("acme"), { catalogue: catalogue(configuration) })
    yield* (yield* PluginFilesFake).offer(source, installed("acme"))
    return yield* importPlugin(you, source)
  })

describe("plugin trust", () => {
  it.effect("lands an import inert and starts it once you enable it", () =>
    withPlugins(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeFake
      const imported = yield* importAcme([])
      yield* settle
      expect(imported.trust).toBe("inert")
      expect(yield* runtime.launches(name("acme"))).toHaveLength(0)

      yield* enablePlugin(you, name("acme"), imported.digest)
      yield* settle

      expect(yield* pluginOf("acme")).toMatchObject({ trust: "enabled", process: "running", configuration: { _tag: "Set" } })
      expect(yield* runtime.launches(name("acme"))).toHaveLength(1)
      expect(yield* changeKinds("acme")).toEqual([["import", "You"], ["enable", "You"]])
    })))

  it.effect("returns an enabled plugin to inert and stops it when its files change", () =>
    withPlugins(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeFake
      const imported = yield* importAcme([])
      yield* enablePlugin(you, name("acme"), imported.digest)
      yield* settle

      yield* (yield* PluginFilesFake).edit(`${pluginRoot}/acme`, "sha256-b")
      yield* settle

      expect(yield* pluginOf("acme")).toMatchObject({ trust: "inert", digest: "sha256-b", process: "stopped" })
      expect(yield* runtime.openStreams(name("acme"))).toBe(0)
      expect(yield* (yield* AlertSinkFake).shown).toContainEqual(expect.objectContaining({ plugin: "acme" }))
      const refused = yield* Effect.exit(enablePlugin(you, name("acme"), imported.digest))
      expect(Exit.isFailure(refused)).toBe(true)
    })))
})

describe("official plugins on first use", () => {
  it.effect("fetches, enables and describes a plugin whose checksum matches", () =>
    withPlugins(Effect.gen(function*() {
      yield* (yield* PluginRuntimeFake).define(name("github-pr"), { catalogue: catalogue() })
      yield* (yield* PluginFilesFake).publish(installed("github-pr", officialDigest))

      const described = yield* (yield* PluginAccess.PluginAccess).describe(you, name("github-pr"), { name: "acme/app#1" })

      expect(described.subject).toBe("acme/app#1")
      expect(yield* pluginOf("github-pr")).toMatchObject({ trust: "enabled", origin: { _tag: "Official" } })
      expect(yield* changeKinds("github-pr")).toEqual([["fetch", "You"]])
    })))

  it.effect("keeps a plugin whose checksum does not match inert and raises the alert", () =>
    withPlugins(Effect.gen(function*() {
      yield* (yield* PluginRuntimeFake).define(name("github-pr"), { catalogue: catalogue() })
      yield* (yield* PluginFilesFake).publish(installed("github-pr", "sha256-tampered"))

      const result = yield* Effect.exit(
        (yield* PluginAccess.PluginAccess).describe(you, name("github-pr"), { name: "acme/app#1" })
      )

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* pluginOf("github-pr")).toMatchObject({ trust: "inert" })
      expect(yield* (yield* AlertSinkFake).shown).toHaveLength(1)
      expect(yield* (yield* PluginRuntimeFake).launches(name("github-pr"))).toHaveLength(0)
    })))
})

describe("configure", () => {
  const ready = Effect.gen(function*() {
    const imported = yield* importAcme()
    yield* enablePlugin(you, name("acme"), imported.digest)
    yield* settle
  })

  it.effect("sends the secret to the plugin's Configure call and nowhere else", () =>
    withPlugins(Effect.gen(function*() {
      yield* ready
      expect(yield* pluginOf("acme")).toMatchObject({ configuration: { _tag: "Missing" } })

      const plugin = yield* configurePlugin(you, name("acme"), { host: "github.com", token: "s3cret" })

      expect(plugin).toMatchObject({ configuration: { _tag: "Set" }, configuredBy: you })
      expect(yield* (yield* PluginRuntimeFake).configured(name("acme"))).toContainEqual({ host: "github.com", token: "s3cret" })
      const repository = yield* PluginRepository.PluginRepository
      const recorded = JSON.stringify([plugin, yield* repository.values(name("acme")), yield* repository.changes(name("acme"))])
      expect(recorded).not.toContain("s3cret")
    })))

  it.effect("clears the stored secrets when the host changes", () =>
    withPlugins(Effect.gen(function*() {
      yield* ready
      yield* configurePlugin(you, name("acme"), { host: "github.com", token: "s3cret" })

      const plugin = yield* configurePlugin(you, name("acme"), { host: "ghe.example.com" })

      const token = yield* (yield* SecretStore.SecretStore).get(name("acme"), "token")
      expect(Option.map(token, Redacted.value)).toEqual(Option.none())
      expect(plugin.configuration).toEqual({ _tag: "Missing" })
    })))

  it.effect("marks rejected credentials without echoing them, alerts you and suspends the subscriptions after an hour", () =>
    withPlugins(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeFake
      yield* runtime.define(name("acme"), {
        catalogue: catalogue(hostAndToken),
        configure: (values) => values.token === "bad" ? { _tag: "Rejected", reason: `401 for ${values.token}` } : { _tag: "Accepted" }
      })
      yield* (yield* PluginFilesFake).offer(source, installed("acme"))
      const imported = yield* importPlugin(you, source)
      yield* enablePlugin(you, name("acme"), imported.digest)
      yield* settle
      yield* configurePlugin(you, name("acme"), { host: "github.com", token: "good" })
      yield* activeSubscription("acme", "sub_one")
      yield* (yield* PluginAccess.PluginAccess).watch("sub_one" as never)
      yield* settle
      expect(yield* runtime.openStreams(name("acme"))).toBe(1)

      const result = yield* Effect.exit(configurePlugin(you, name("acme"), { token: "bad" }))

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* pluginOf("acme")).toMatchObject({ configuration: { _tag: "Rejected", reason: "401 for [secret]" } })
      expect(JSON.stringify(yield* (yield* AlertSinkFake).shown)).not.toContain("bad")
      expect(yield* (yield* AlertSinkFake).shown).toContainEqual(expect.objectContaining({ _tag: "CredentialsRejected" }))
      yield* settle
      expect(yield* runtime.openStreams(name("acme"))).toBe(0)
      yield* TestClock.adjust("1 hour")
      yield* settle
      expect(yield* (yield* SubscriptionIntakeFake).suspensions).toEqual([
        expect.objectContaining({ plugin: "acme" })
      ])
    })))
})

describe("the management group", () => {
  it("offers its use cases only outside the agent group", () => {
    const agent = [...DaemonContract.AgentGroup.requests.keys()]
    expect(Object.keys(management).sort()).toEqual([...DaemonContract.ManagementGroup.requests.keys()].sort())
    expect(Object.keys(management).filter((method) => agent.includes(method))).toEqual([])
  })
})
