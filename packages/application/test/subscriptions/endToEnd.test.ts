import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import type { Catalogue, Session } from "@exangelos/domain"
import { ConnectorAccessFake, WakeTargetFake } from "@exangelos/application/testing"
import { ConnectorRepository } from "../../src/ports/ConnectorRepository.ts"
import { SubscriptionIntake } from "../../src/seam/SubscriptionIntake.ts"
import { deliverDue } from "../../src/subscriptions/daemon/Delivery.ts"
import { subscribe } from "../../src/subscriptions/useCases/index.ts"
import { catalogue, connector } from "../fixtures.ts"
import { layer, reported } from "./daemon/support.ts"

const own: Session.Session = { harness: "t3", sessionId: "own" }
const prs = Ids.ConnectorName.make("github-pr")

describe("a subscription end to end", () => {
  it.effect("subscribe, ingest and a delivered wake", () =>
    Effect.gen(function*() {
      yield* (yield* ConnectorRepository).store(connector("github-pr"))
      const access = yield* ConnectorAccessFake
      yield* access.define(prs, {
        catalogue,
        describe: (parameters: Catalogue.Parameters) =>
          Effect.succeed({ catalogue, parameters, subject: "pr 7", label: "PR" })
      })
      const subscription = yield* subscribe({ _tag: "Session", session: own }, {
        connector: prs,
        parameters: { pr: 7 },
        intent: "Merge once CI is green",
        target: { _tag: "Caller" },
        similarOk: []
      }, [own])

      const intake = yield* SubscriptionIntake
      expect(yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("ci") })).toBe("continue")
      yield* TestClock.adjust("5 seconds")
      yield* deliverDue

      const delivered = yield* (yield* WakeTargetFake).delivered
      expect(delivered.map((content) => content.why._tag)).toEqual(["Events"])
    }).pipe(Effect.provide(layer)))
})
