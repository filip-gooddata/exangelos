import { ledgerProcess, ledgerTestTimeout } from "./LedgerProcess.ts"
import { expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { reconcile } from "../src/Reconcile.ts"

const token = (n: number) => n.toString(16).padStart(64, "0")
const message = (n: number, reply = false) => ({
  id: token(n), body: token(100), reply, reactions: [token(200)], reactionsComplete: true
})
const snapshot = (messages = [message(1)], generation = "2") => ({
  scope: token(0), complete: true, messages, generation,
  snapshot: createHash("sha256").update(JSON.stringify(messages)).digest("hex")
})

it.effect("real Python ledger replays the committed batch before considering a changed snapshot", () => Effect.gen(function*() {
  const initial = yield* reconcile(undefined, snapshot([message(1)], "1"))
  const first = yield* reconcile(initial.cursor, snapshot([message(1), message(3, true)]))
  const newer = snapshot([message(1), message(2), message(3, true)], "3")
  expect(yield* reconcile(initial.cursor, newer)).toEqual(first)
  const next = yield* reconcile(first.cursor, newer)
  expect(next.events.map((event) => event.type)).toEqual(["message.new"])
  expect(next.events[0]?.dedupeKey).not.toBe(first.events[0]?.dedupeKey)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger baselines silently and resumes without repeating observed changes", () => Effect.gen(function*() {
  const initial = yield* reconcile(undefined, snapshot([message(1)], "1"))
  expect(initial.events).toEqual([])
  const changed = snapshot([
    { ...message(1), body: token(101), reactions: [token(201)] }, message(2), message(3, true)
  ])
  const next = yield* reconcile(initial.cursor, changed)
  expect(next.events.map((event) => event.type)).toEqual([
    "message.edited", "reaction.added", "reaction.removed", "message.new", "thread.reply"
  ])
  expect(new Set(next.events.map((event) => event.dedupeKey)).size).toBe(5)
  expect(yield* reconcile(initial.cursor, changed)).toEqual(next)
  expect((yield* reconcile(next.cursor, changed)).events).toEqual([])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger rejects incomplete coverage and invalid resume state without leaking source values", () => Effect.gen(function*() {
  const initial = yield* reconcile(undefined, snapshot([message(1)], "1"))
  for (const [cursor, input] of [
    [initial.cursor, { ...snapshot([]), complete: false }],
    ["private-source-value", snapshot()],
    [initial.cursor, { ...snapshot(), scope: token(9) }],
    [initial.cursor, snapshot([message(1), message(1)])]
  ] as const) {
    const error = yield* reconcile(cursor, input).pipe(Effect.flip)
    expect(error._tag).toBe("ObservationGap")
    expect(JSON.stringify(error)).not.toContain("private-source-value")
  }
  const absent = yield* reconcile(initial.cursor, snapshot([]))
  expect(absent.events).toEqual([])
  const returned = yield* reconcile(absent.cursor, snapshot([message(1)], "3"))
  expect(returned.events).toEqual([])
  const removed = yield* reconcile(returned.cursor, snapshot([{ ...message(1), reactions: [] }], "4"))
  expect(removed.events.map((event) => event.type)).toEqual(["reaction.removed"])
  const restored = yield* reconcile(removed.cursor, snapshot([message(1)], "5"))
  expect(restored.events.map((event) => event.type)).toEqual(["reaction.added"])
  expect(restored.events[0]?.dedupeKey).not.toBe(removed.events[0]?.dedupeKey)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger rejects backwards and conflicting generations across restart", () => Effect.gen(function*() {
  const initial = yield* reconcile(undefined, snapshot([message(1)], "9007199254740994"))
  expect(yield* reconcile(initial.cursor, snapshot([message(1)], "9007199254740994"))).toEqual({ events: [], cursor: initial.cursor })
  for (const input of [snapshot([], "9007199254740993"), snapshot([], "9007199254740994")]) {
    expect((yield* reconcile(initial.cursor, input).pipe(Effect.flip))._tag).toBe("ObservationGap")
  }
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger does not infer reaction changes across incomplete coverage", () => Effect.gen(function*() {
  const initial = yield* reconcile(undefined, snapshot([message(1)], "1"))
  const unknown = yield* reconcile(initial.cursor, snapshot([{ ...message(1), body: token(101), reactions: [], reactionsComplete: false }], "2"))
  expect(unknown.events.map((event) => event.type)).toEqual(["message.edited"])
  const covered = yield* reconcile(unknown.cursor, snapshot([{ ...message(1), body: token(101), reactions: [] }], "3"))
  expect(covered.events).toEqual([])
  const added = yield* reconcile(covered.cursor, snapshot([{ ...message(1), body: token(101) }], "4"))
  expect(added.events.map((event) => event.type)).toEqual(["reaction.added"])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger supports 500-message turnover and historical return without a lifetime ceiling", () => Effect.gen(function*() {
  const original = Array.from({ length: 500 }, (_, n) => message(n + 1))
  const initial = yield* reconcile(undefined, snapshot(original, "1"))
  const turned = yield* reconcile(initial.cursor, snapshot([...original.slice(1), message(501)], "2"))
  expect(turned.events.map((event) => event.type)).toEqual(["message.new"])
  expect(turned.cursor.length).toBeLessThan(512)
  expect(turned.cursor).not.toContain(token(501))
  const returned = yield* reconcile(turned.cursor, snapshot([message(1)], "3"))
  expect(returned.events).toEqual([])
  const edited = yield* reconcile(returned.cursor, snapshot([{ ...message(1), body: token(101) }], "4"))
  expect(edited.events.map((event) => event.type)).toEqual(["message.edited"])
  const independent = yield* reconcile(undefined, snapshot([message(1)], "5"))
  expect(independent.events).toEqual([])
  expect(independent.cursor).not.toBe(initial.cursor)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)
