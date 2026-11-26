import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { Template } from "@exangelos/connector-template"

const configured = Effect.gen(function*() {
  const client = yield* ConnectorTest.makeClient(Template.connector)
  yield* client.Configure({ values: { token: "secret" } })
  return client
})

const watch = (parameters: Record<string, unknown>, cursor?: string) =>
  Effect.gen(function*() {
    const client = yield* configured
    return yield* client.Watch({
      parameters,
      eventTypes: [Template.tick.type],
      ...(cursor === undefined ? {} : { cursor })
    }).pipe(Stream.runCollect)
  })

describe("template connector", () => {
  it.effect("names its subject after the number of ticks", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(Template.connector)

      expect(yield* client.Describe({ parameters: { ticks: 3 } })).toEqual({
        _tag: "Described",
        parameters: { ticks: 3 },
        subject: "ticks:3",
        label: "3 ticks"
      })
      expect((yield* client.Describe({ parameters: { ticks: -1 } }))._tag).toBe("Invalid")
      expect(yield* client.Describe({ parameters: { ticks: "3" } })).toMatchObject({ parameters: { ticks: 3 } })
      expect((yield* client.Describe({ parameters: { ticks: "3.5" } }))._tag).toBe("Invalid")
    }).pipe(Effect.scoped))

  it.effect("emits the requested ticks and then ends", () =>
    Effect.gen(function*() {
      const items = yield* watch({ ticks: 2 })

      expect(items.map((item) => item._tag)).toEqual(["Event", "Event", "End"])
      expect(items[1]).toMatchObject({
        event: { type: "tick", summary: "Tick 2 of 2", payload: { index: 2 }, dedupeKey: "tick-2" },
        cursor: "2"
      })
      expect(items[2]).toEqual({ _tag: "End", reason: "Emitted 2 ticks; wake window 5000 ms" })
    }).pipe(Effect.scoped))

  it.effect("waits without ending when no ticks are requested", () =>
    Effect.gen(function*() {
      const client = yield* configured
      const items = yield* client.Watch({ parameters: { ticks: 0 }, eventTypes: [], acceptsPending: true }).pipe(
        Stream.take(1),
        Stream.runCollect
      )

      expect(items).toEqual([{ _tag: "Pending", reason: "No ticks requested yet", cursor: "0" }])
    }).pipe(Effect.scoped))

  it.effect("resumes after the cursor it was given", () =>
    Effect.gen(function*() {
      const items = yield* watch({ ticks: 3 }, "2")

      expect(items.map((item) => item._tag === "Event" ? item.event.dedupeKey : item._tag)).toEqual(["tick-3", "End"])
    }).pipe(Effect.scoped))

  it.effect("refuses to watch before it is configured", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(Template.connector)
      const error = yield* client.Watch({ parameters: { ticks: 1 }, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip)

      expect(error._tag).toBe("CredentialsRejected")
    }).pipe(Effect.scoped))
})
