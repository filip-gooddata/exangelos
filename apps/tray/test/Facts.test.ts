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
