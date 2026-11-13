import { describe, expect, it } from "@effect/vitest"
import type { Subscription } from "@exangelos/domain"
import { DateTime } from "effect"
import * as Facts from "../src/view/Facts.ts"
import { subscription } from "./fixtures.ts"

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
      { _tag: "Choice", key: "mode", label: "Mode", required: false, choices: [" left "], secretDestination: false }
    ] as const
    expect(Facts.filledValues(fields, { site: " https://a ", token: "" })).toEqual({ site: "https://a" })
    expect(Facts.filledValues(fields, { mode: " left " })).toEqual({ mode: " left " })
  })
})
