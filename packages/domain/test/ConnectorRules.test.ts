import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import type { Catalogue } from "../src/index.ts"
import { Alert, Ids, Lifecycle, ConnectorRules, Settings } from "../src/index.ts"
import { at, event, connector, subscription } from "./fixtures.ts"

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

describe("ConnectorRules", () => {
  it("rule 16: an unavailable connector suspends its active subscriptions and records since when", () => {
    expect(ConnectorRules.isAvailable(connector())).toBe(true)
    expect(ConnectorRules.isAvailable(connector({ trust: "dev" }))).toBe(true)
    expect(ConnectorRules.problem(connector({ trust: "inert" }))).toEqual(Option.some("it waits to be enabled"))
    expect(ConnectorRules.problem(connector({ process: "failing" }))).toEqual(Option.some("it keeps failing"))
    expect(ConnectorRules.problem(connector({ configuration: { _tag: "Missing" } }))).toEqual(
      Option.some("its configuration is missing")
    )
    expect(ConnectorRules.problem(connector({ configuration: { _tag: "Rejected", reason: "bad token" } }))).toEqual(
      Option.some("its configuration was rejected: bad token")
    )

    const down = ConnectorRules.trackAvailability(connector({ process: "failing" }), at("2026-11-01T10:00:00Z"))
    const stillDown = ConnectorRules.trackAvailability(down, at("2026-11-01T11:00:00Z"))
    expect(stillDown.unavailableSince).toEqual(at("2026-11-01T10:00:00Z"))
    expect(ConnectorRules.trackAvailability({ ...stillDown, process: "running" }, at("2026-11-01T12:00:00Z"))).not.toHaveProperty(
      "unavailableSince"
    )
    expect(Lifecycle.isSuspended(subscription(), connector({ trust: "inert" }))).toBe(true)
    expect(Lifecycle.isSuspended(subscription({ state: { _tag: "Expired" } }), connector({ trust: "inert" }))).toBe(false)
  })

  it("rule 19: a third-party connector starts inert, an official one is enabled by checksum, file changes make both inert and restart dev ones", () => {
    const name = Ids.ConnectorName.make("github-pr")
    const official = connector({ origin: { _tag: "Official", version: "1.0.0" } })
    expect(ConnectorRules.initialTrust(connector().origin, "sha256-a", Option.none())).toBe("inert")
    expect(ConnectorRules.initialTrust(official.origin, "sha256-ok", Option.some("sha256-ok"))).toBe("enabled")
    expect(ConnectorRules.trustAlert({ ...official, trust: "inert", digest: "sha256-bad" }, Option.some("sha256-ok")))
      .toEqual(Option.some({ _tag: "DigestMismatch", connector: name }))
    expect(ConnectorRules.trustAlert(connector({ trust: "inert" }), Option.none())).toEqual(
      Option.some({ _tag: "WaitsForEnable", connector: name })
    )

    expect(ConnectorRules.filesChanged(connector(), "sha256-b")).toEqual({
      connector: connector({ trust: "inert", digest: "sha256-b", process: "stopped" }),
      restart: false,
      alert: Option.some({ _tag: "WaitsForEnable", connector: name })
    })
    expect(ConnectorRules.filesChanged(official, "sha256-ok")).toMatchObject({
      connector: { trust: "inert", process: "stopped" },
      restart: false,
      alert: Option.some({ _tag: "DigestMismatch", connector: name })
    })

    const dev = connector({ trust: "dev", origin: { _tag: "DevLink", path: "/src/p" } })
    expect(ConnectorRules.filesChanged(dev, "sha256-c")).toMatchObject({ connector: { trust: "dev" }, restart: true })
  })

  it("rule 21: alerts when a connector keeps failing or its credentials are rejected, and on events only when turned on", () => {
    const name = Ids.ConnectorName.make("github-pr")
    expect(
      ConnectorRules.alerts(
        Option.some(connector()),
        connector({ process: "failing", configuration: { _tag: "Rejected", reason: "401" } })
      )
    ).toEqual([
      { _tag: "Failing", connector: name, reason: "it keeps failing" },
      { _tag: "CredentialsRejected", connector: name, reason: "401" }
    ])
    expect(ConnectorRules.alerts(Option.some(connector({ process: "failing" })), connector({ process: "failing" }))).toEqual([])
    expect(ConnectorRules.alerts(Option.some(connector()), connector({ trust: "inert" }))).toEqual([])
    expect(Alert.forEvent(Settings.initial, subscription(), event(1))).toEqual(Option.none())
    expect(Alert.forEvent(Settings.initial, subscription({ eventAlerts: true }), event(1))).toEqual(
      Option.some({ _tag: "Event", subscription: "sub_7f3k", connector: "github-pr", subject: "acme/app#123", event: event(1) })
    )
  })

  it("counts a connector as configured when every required field has a value", () => {
    expect(ConnectorRules.configuration(catalogue([]), {}, [])).toEqual({ _tag: "Set" })
    expect(ConnectorRules.configuration(github, { host: "github.com" }, [])).toEqual({ _tag: "Missing" })
    expect(ConnectorRules.configuration(github, { host: "github.com" }, ["token"])).toEqual({ _tag: "Set" })
  })

  it("rule 20: changing where secrets are sent clears the stored secrets", () => {
    const before = { host: "github.com", team: "core" }
    expect(ConnectorRules.clearsSecrets(github, before, { ...before, team: "web" })).toBe(false)
    expect(ConnectorRules.clearsSecrets(github, before, { ...before, host: "evil.example" })).toBe(true)
  })
})
