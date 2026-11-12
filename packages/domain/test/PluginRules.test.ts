import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import type { Catalogue } from "../src/index.ts"
import { Alert, Ids, Lifecycle, PluginRules, Settings } from "../src/index.ts"
import { at, event, plugin, subscription } from "./fixtures.ts"

const catalogue = (configuration: Catalogue.Catalogue["configuration"]): Catalogue.Catalogue => ({
  eventTypes: [{ type: Ids.EventType.make("checks.failed"), description: "CI failed", payload: {} }],
  parameters: { main: "pr", schema: {} },
  configuration
})

const github = catalogue([
  { _tag: "Text", key: "host", label: "Host", required: true, secretDestination: true },
  { _tag: "Text", key: "team", label: "Team", required: false, secretDestination: false },
  { _tag: "Secret", key: "token", label: "Token", required: true }
])

describe("PluginRules", () => {
  it("rule 16: an unavailable plugin suspends its active subscriptions and records since when", () => {
    expect(PluginRules.isAvailable(plugin())).toBe(true)
    expect(PluginRules.isAvailable(plugin({ trust: "dev" }))).toBe(true)
    expect(PluginRules.problem(plugin({ trust: "inert" }))).toEqual(Option.some("it waits to be enabled"))
    expect(PluginRules.problem(plugin({ process: "failing" }))).toEqual(Option.some("it keeps failing"))
    expect(PluginRules.problem(plugin({ configuration: { _tag: "Missing" } }))).toEqual(
      Option.some("its configuration is missing")
    )
    expect(PluginRules.problem(plugin({ configuration: { _tag: "Rejected", reason: "bad token" } }))).toEqual(
      Option.some("its configuration was rejected: bad token")
    )

    const down = PluginRules.trackAvailability(plugin({ process: "failing" }), at("2026-11-01T10:00:00Z"))
    const stillDown = PluginRules.trackAvailability(down, at("2026-11-01T11:00:00Z"))
    expect(stillDown.unavailableSince).toEqual(at("2026-11-01T10:00:00Z"))
    expect(PluginRules.trackAvailability({ ...stillDown, process: "running" }, at("2026-11-01T12:00:00Z"))).not.toHaveProperty(
      "unavailableSince"
    )
    expect(Lifecycle.isSuspended(subscription(), plugin({ trust: "inert" }))).toBe(true)
    expect(Lifecycle.isSuspended(subscription({ state: { _tag: "Expired" } }), plugin({ trust: "inert" }))).toBe(false)
  })

  it("rule 19: file changes make third-party plugins inert, re-check official ones and restart dev ones", () => {
    const name = Ids.PluginName.make("github-pr")
    expect(PluginRules.trustAlert(plugin({ trust: "inert" }), Option.none())).toEqual(
      Option.some({ _tag: "WaitingToBeEnabled", plugin: name })
    )
    expect(PluginRules.filesChanged(plugin(), "sha256-b", Option.none())).toMatchObject({
      plugin: { trust: "inert", digest: "sha256-b", process: "stopped" },
      restart: false,
      alert: Option.some({ _tag: "WaitingToBeEnabled", plugin: name })
    })

    const official = plugin({ origin: { _tag: "Official", version: "1.0.0" } })
    expect(PluginRules.initialTrust(official.origin, "sha256-ok", Option.some("sha256-ok"))).toBe("enabled")
    expect(PluginRules.filesChanged(official, "sha256-ok", Option.some("sha256-ok"))).toMatchObject({
      plugin: { trust: "enabled" },
      restart: true,
      alert: Option.none()
    })
    expect(PluginRules.filesChanged(official, "sha256-bad", Option.some("sha256-ok"))).toMatchObject({
      plugin: { trust: "inert" },
      alert: Option.some({ _tag: "ChecksumMismatch", plugin: name })
    })
    expect(PluginRules.filesChanged({ ...official, trust: "inert" }, "sha256-ok", Option.some("sha256-ok")).plugin.trust)
      .toBe("inert")

    const dev = plugin({ trust: "dev", origin: { _tag: "DevLink", path: "/src/p" } })
    expect(PluginRules.filesChanged(dev, "sha256-c", Option.none())).toMatchObject({ plugin: { trust: "dev" }, restart: true })
  })

  it("rule 21: alerts when a plugin keeps failing or its credentials are rejected, and on events only when turned on", () => {
    const name = Ids.PluginName.make("github-pr")
    expect(
      PluginRules.alerts(
        Option.some(plugin()),
        plugin({ process: "failing", configuration: { _tag: "Rejected", reason: "401" } })
      )
    ).toEqual([
      { _tag: "KeepsFailing", plugin: name },
      { _tag: "CredentialsRejected", plugin: name, reason: "401" }
    ])
    expect(PluginRules.alerts(Option.some(plugin({ process: "failing" })), plugin({ process: "failing" }))).toEqual([])
    expect(PluginRules.alerts(Option.some(plugin()), plugin({ trust: "inert" }))).toEqual([])
    expect(Alert.forEvent(Settings.initial, subscription(), event(1))).toEqual(Option.none())
    expect(Alert.forEvent(Settings.initial, subscription({ eventAlerts: true }), event(1))).toEqual(
      Option.some({ _tag: "Event", subscription: "sub_7f3k", number: 1, summary: "event 1" })
    )
  })

  it("counts a plugin as configured when every required field has a value", () => {
    expect(PluginRules.configuration(catalogue([]), {}, [])).toEqual({ _tag: "Set" })
    expect(PluginRules.configuration(github, { host: "github.com" }, [])).toEqual({ _tag: "Missing" })
    expect(PluginRules.configuration(github, { host: "github.com" }, ["token"])).toEqual({ _tag: "Set" })
  })

  it("rule 20: changing where secrets are sent clears the stored secrets", () => {
    const before = { host: "github.com", team: "core" }
    expect(PluginRules.clearsSecrets(github, before, { ...before, team: "web" })).toBe(false)
    expect(PluginRules.clearsSecrets(github, before, { ...before, host: "evil.example" })).toBe(true)
  })
})
