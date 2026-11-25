import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import type { Catalogue, Connector, Session } from "@exangelos/domain"
import { ConnectorAccessFake, WakeTargetFake } from "@exangelos/application/testing"
import { ConnectorRepository } from "../../src/ports/ConnectorRepository.ts"
import { SubscriptionIntake } from "../../src/seam/SubscriptionIntake.ts"
import { deliverDue } from "../../src/subscriptions/daemon/Delivery.ts"
import { list, show, subscribe } from "../../src/subscriptions/useCases/index.ts"
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

  it.effect("an observation outage: visible in list and show, one failing wake, one recovered wake, quiet when it flaps", () =>
    Effect.gen(function*() {
      yield* (yield* ConnectorRepository).store(connector("github-pr"))
      const access = yield* ConnectorAccessFake
      yield* access.define(prs, {
        catalogue,
        describe: (parameters: Catalogue.Parameters) =>
          Effect.succeed({ catalogue, parameters, subject: "pr 7", label: "PR" })
      })
      const actor = { _tag: "Session", session: own } as const
      const subscription = yield* subscribe(actor, {
        connector: prs,
        parameters: { pr: 7 },
        intent: "Merge once CI is green",
        target: { _tag: "Caller" },
        similarOk: []
      }, [own])
      const intake = yield* SubscriptionIntake
      const target = yield* WakeTargetFake
      const whys = Effect.map(target.delivered, (all) => all.map((content) => content.why._tag))
      const outage = (minutes: number) =>
        Effect.gen(function*() {
          const failure: Connector.ObservationFailure = {
            category: "unavailable",
            reason: "socket closed",
            since: yield* DateTime.now
          }
          yield* access.observe(subscription.id, failure)
          for (let minute = 0; minute <= minutes; minute++) {
            yield* intake.observationFailing(subscription.id, failure)
            yield* deliverDue
            if (minute < minutes) yield* TestClock.adjust("1 minute")
          }
        })
      const recover = Effect.gen(function*() {
        yield* access.observe(subscription.id, undefined)
        yield* intake.observationRecovered(subscription.id)
        yield* deliverDue
      })

      yield* outage(4)
      expect(yield* whys).toEqual([])
      yield* outage(6)
      expect(yield* whys).toEqual(["Failing"])
      expect((yield* target.delivered)[0]?.why).toMatchObject({ category: "unavailable", reason: "socket closed" })
      const [listed] = yield* list(actor, { all: false })
      expect(listed?.observation).toEqual({ category: "unavailable", since: expect.anything() })
      expect((yield* show(actor, { id: subscription.id })).subscription.observation).toMatchObject({ reason: "socket closed" })

      yield* recover
      yield* recover
      expect(yield* whys).toEqual(["Failing", "Recovered"])

      yield* outage(10)
      yield* recover
      expect(yield* whys).toEqual(["Failing", "Recovered"])
      const [quiet] = yield* list(actor, { all: false })
      expect(quiet?.observation).toBeUndefined()
    }).pipe(Effect.provide(layer)))
})
