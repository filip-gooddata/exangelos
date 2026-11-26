import { describe, expect, it } from "@effect/vitest"
import { DaemonContract } from "@exangelos/contracts"
import type { Subscription } from "@exangelos/domain"
import { DateTime } from "effect"
import * as Facts from "../src/view/Facts.ts"
import { connector, subscription } from "./fixtures.ts"

const change = (kind: string, detail?: string): Subscription.Change => ({
  subscription: subscription().id,
  kind: kind as Subscription.ChangeKind,
  actor: { _tag: "You" },
  at: DateTime.makeUnsafe(0),
  ...(detail === undefined ? {} : { detail })
})

describe("Facts", () => {
  it("titles changes, including kinds it has no title for yet", () => {
    expect(Facts.changeTitle(change("ack", "through #4"))).toBe("Acknowledged: through #4")
    expect(Facts.changeTitle(change("eventAlerts", "off"))).toBe("Event alerts turned off")
    expect(Facts.changeTitle(change("eventAlerts", "on"))).toBe("Event alerts turned on")
  })

  it("says why an active watch waits, unless its source is failing", () => {
    const waiting = { ...subscription(), waiting: "Not in the local cache yet." }
    expect(Facts.stateSentence(0, waiting)).toMatch(/^Active\. Waiting: Not in the local cache yet\. Expires/)
    const failing = { ...waiting, observation: { category: "unavailable", since: DateTime.makeUnsafe(0) } } as const
    expect(Facts.stateSentence(0, failing)).toMatch(/^Active, but its source has been failing since/)
    expect(Facts.stateSentence(0, failing)).not.toContain("Waiting")
  })

  it("acknowledges through the chosen pending event, else the newest", () => {
    const s = subscription({ ackedThrough: 3, lastNumber: 7 })
    expect(Facts.ackThroughNumber(s, null)).toBe(7)
    expect(Facts.ackThroughNumber(s, 5)).toBe(5)
    expect(Facts.ackThroughNumber(s, 2)).toBe(7)
    expect(Facts.ackThroughNumber(subscription({ ackedThrough: 7, lastNumber: 7 }), 5)).toBeUndefined()
  })

  it("builds an import only once its fields are filled", () => {
    expect(Facts.importSource("Directory", "  /src/x ", "")).toEqual({ _tag: "Directory", path: "/src/x" })
    expect(Facts.importSource("GitRepository", "https://g/x", " ")).toBeUndefined()
    expect(Facts.importSource("GitRepository", "https://g/x", "v1")).toEqual({ _tag: "GitRepository", url: "https://g/x", ref: "v1" })
    expect(Facts.importSource("HttpsLink", "", "")).toBeUndefined()
  })

  it("sends only the configuration fields you filled in", () => {
    const fields = [
      { _tag: "Text", key: "site", label: "Site", required: true, secretDestination: false },
      { _tag: "Secret", key: "token", label: "Token", required: true },
      { _tag: "Choice", key: "mode", label: "Mode", required: false, choices: [" left ", " "], secretDestination: false }
    ] as const
    expect(Facts.filledValues(fields, { site: " https://a ", token: "" })).toEqual({ site: "https://a" })
    expect(Facts.filledValues(fields, { mode: " left " })).toEqual({ mode: " left " })
    expect(Facts.filledValues(fields, { mode: " ", site: "  " })).toEqual({ mode: " " })
  })
  it("hides only secret fields, not the text fields that say where secrets go", () => {
    expect(Facts.isSecretField({ _tag: "Secret", key: "token", label: "Token", required: true })).toBe(true)
    expect(Facts.isSecretField({ _tag: "Text", key: "site", label: "Site", required: true, secretDestination: true }))
      .toBe(false)
    expect(Facts.isSecretField({ _tag: "Text", key: "email", label: "Email", required: true, secretDestination: false }))
      .toBe(false)
  })
  it("names the event to acknowledge through when resume is over the backlog limit", () => {
    const over = (reason: "count" | "age") => Facts.refusalText(new DaemonContract.BacklogOverLimit({ pending: 25, limit: 20, through: 41, reason }))
    expect(over("count")).toBe("The backlog holds 25 pending events, over the limit of 20. Acknowledge through event 41, then resume.")
    expect(over("age")).toBe("The oldest of the 25 pending events is past the age limit. Acknowledge through event 41, then resume.")
  })
})

describe("secretStored", () => {
  const token = { _tag: "Secret", key: "token", label: "Token", required: true } as const
  const optional = { ...token, required: false }

  it("says set only for a required secret of a complete configuration", () => {
    expect(Facts.secretStored(connector({ configuration: { _tag: "Set" } }), token)).toBe(true)
    expect(Facts.secretStored(connector({ configuration: { _tag: "Rejected", reason: "401" } }), token)).toBe(true)
  })

  it("stays unknown for an optional secret or an incomplete configuration, even one never saved", () => {
    expect(Facts.secretStored(connector({ configuration: { _tag: "Set" } }), optional)).toBeUndefined()
    expect(Facts.secretStored(connector({ configuration: { _tag: "Missing" } }), token)).toBeUndefined()
  })
})

describe("sessions, logos and rows", () => {
  it("names a session by its resolved title, else by its shortened id", () => {
    const t3 = { harness: "t3", sessionId: "37b94c9c-84e8-4980-bcec-1c528c34369e" } as const
    const codex = { harness: "codex", sessionId: "short-id" } as const
    const titles = Facts.titlesFrom([{ ...t3, title: "Tooling: Exangelos" }])
    expect(Facts.sessionTitle(t3, titles)).toBe("Tooling: Exangelos")
    expect(Facts.sessionTitle(t3, Facts.noTitles)).toBe("37b94c9c…")
    expect(Facts.sessionTitle(codex, titles)).toBe("short-id")
    expect(Facts.sessionHover(t3)).toBe("T3 Code session 37b94c9c-84e8-4980-bcec-1c528c34369e")
  })

  it("serves a connector's icon as a data URL and nothing when it has none", () => {
    const withIcon = { ...connector(), icon: { mediaType: "image/svg+xml", data: "PHN2Zy8+" } } as const
    expect(Facts.connectorIcon([withIcon], "github-pr")).toBe("data:image/svg+xml;base64,PHN2Zy8+")
    expect(Facts.connectorIcon([connector()], "github-pr")).toBeUndefined()
    expect(Facts.connectorIcon([withIcon], "jira")).toBeUndefined()
  })

  it("keeps a plain active row to two lines and tells the state otherwise", () => {
    const now = DateTime.toEpochMillis(subscription().createdAt)
    expect(Facts.rowFact(now, subscription(), undefined, Facts.noTitles)).toBeUndefined()
    const soon = subscription({ expiresAt: DateTime.add(subscription().createdAt, { hours: 3 }) })
    expect(Facts.rowFact(now, soon, undefined, Facts.noTitles)).toBe("Expires in 3 h")
    const paused = subscription({ state: { _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } } })
    expect(Facts.rowFact(now, paused, undefined, Facts.noTitles)).toMatch(/^Paused .*backlog reached 20/)
    expect(Facts.rowHover(now, subscription())).toBe("github-pr: acme/app#123\nExpires in 7 days")
  })

  it("calls a row by its label, else by its intent, never by its raw subject", () => {
    expect(Facts.rowLabel(subscription({ label: "Checkout fix" }))).toBe("Checkout fix")
    expect(Facts.rowLabel(subscription({ label: "", subject: "slack:0e6ec01d87da", intent: "Wake me on posts" }))).toBe("Wake me on posts")
  })
})
