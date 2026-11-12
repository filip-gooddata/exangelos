import { describe, expect, it } from "@effect/vitest"
import { Option, Result } from "effect"
import type { Subscription } from "../src/index.ts"
import { Ids, Subscribe } from "../src/index.ts"
import { alice, bob, plugin, subscription } from "./fixtures.ts"

const failure = <A, E>(result: Result.Result<A, E>): E | undefined =>
  Result.isFailure(result) ? result.failure : undefined

describe("Subscribe", () => {
  it("rule 1: needs an available plugin and an intent of one non-empty line", () => {
    expect(Subscribe.check(plugin(), "  Fix the build when CI fails ")).toEqual(Result.succeed("Fix the build when CI fails"))
    expect(failure(Subscribe.check(plugin(), " "))).toMatchObject({ _tag: "IntentRequired" })
    expect(failure(Subscribe.check(plugin(), "one\ntwo"))).toMatchObject({ _tag: "IntentRequired" })
    expect(failure(Subscribe.check(plugin({ trust: "inert" }), "Watch"))).toMatchObject({
      _tag: "PluginUnavailable",
      problem: "it waits to be enabled"
    })
  })

  it("rule 2: the wake target is the calling session, a T3 thread when nested, a named one, or none for pull-only", () => {
    expect(Subscribe.wakeTarget([bob, alice], Option.none())).toEqual(Result.succeed(Option.some(alice)))
    expect(Subscribe.wakeTarget([bob], Option.none())).toEqual(Result.succeed(Option.some(bob)))
    expect(Subscribe.wakeTarget([], Option.some({ _tag: "Session", session: bob }))).toEqual(
      Result.succeed(Option.some(bob))
    )
    expect(Subscribe.wakeTarget([alice], Option.some({ _tag: "PullOnly" }))).toEqual(Result.succeed(Option.none()))
    expect(failure(Subscribe.wakeTarget([], Option.none()))).toMatchObject({ _tag: "NoWakeTarget" })
  })

  it("rule 3: refuses a similar open subscription of the same session unless every match is acknowledged", () => {
    const first = subscription({ id: Ids.SubscriptionId.make("sub_a") })
    const others: ReadonlyArray<Subscription.Subscription> = [
      first,
      subscription({ id: Ids.SubscriptionId.make("sub_b"), wakeTarget: bob }),
      subscription({ id: Ids.SubscriptionId.make("sub_c"), state: { _tag: "Ended", reason: { _tag: "MaxEvents" } } }),
      subscription({ id: Ids.SubscriptionId.make("sub_d"), subject: "acme/app#124" })
    ]
    const candidate = { plugin: first.plugin, subject: first.subject, wakeTarget: Option.some(alice) }
    expect(failure(Subscribe.similar(others, candidate, []))).toMatchObject({
      _tag: "SimilarSubscriptions",
      matches: [{ id: "sub_a", parameters: first.parameters }]
    })
    expect(Result.isSuccess(Subscribe.similar(others, candidate, [Ids.SubscriptionId.make("sub_a")]))).toBe(true)
  })

  it("rule 5: an update applies while the plugin reports the same subject", () => {
    const updated = Subscribe.update(subscription(), { intent: "Only care about reviews", maxEvents: 3 }, "acme/app#123")
    expect(Result.getOrThrow(updated)).toMatchObject({ intent: "Only care about reviews", maxEvents: 3 })
    expect(failure(Subscribe.update(subscription(), { parameters: { pr: "acme/app#9" } }, "acme/app#9"))).toMatchObject({
      _tag: "SubjectChanged",
      subject: "acme/app#123",
      reported: "acme/app#9"
    })
  })

  it("rule 18: the default list shows the caller's own subscriptions", () => {
    expect(Subscribe.isOwn(subscription(), alice)).toBe(true)
    expect(Subscribe.isOwn(subscription(), bob)).toBe(false)
  })
})
