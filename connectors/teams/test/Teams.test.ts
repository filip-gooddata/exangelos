import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { ledgerProcess, ledgerTestTimeout } from "./LedgerProcess.ts"
import { ChildProcessSpawner } from "effect/process"
import { localSource, SourceUnavailable } from "../src/Source.ts"
import { observationBudget, resumeWaiting, waitingCursor } from "../../shared/pendingSubject.ts"
import { expect, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Fiber, Layer, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { gap, reconcile, type Snapshot } from "../src/Reconcile.ts"
import { make } from "../src/Teams.ts"

const token = (n: number) => n.toString(16).padStart(64, "0")
const scope = token(1)
const message = { conversationLabel: "Project room", sender: "Alex", messageTime: 10, id: token(2), body: token(3), parent: null, reaction: token(4), reactions: [] as ReadonlyArray<string> }
const snapshot = { scope, includeMessagePreview: false, messages: [message] }

const configuration = { subscriptionAccess: "persisted-cache" }
const resolved = { scope, label: "Project room" }
const pin = `scope-${scope}`
const resolve = () => Effect.succeed(resolved)

it.effect("one explicit cache consent permits independent describes and legacy selections fail closed", () => Effect.gen(function*() {
  const requests: Array<unknown> = []
  const client = yield* ConnectorTest.makeClient(make({
    resolve: (request) => Effect.sync(() => { requests.push(request); return resolved }),
    read: () => Effect.die("unexpected cache read")
  }))
  const catalogue = (yield* client.Handshake()).catalogue
  expect(catalogue.configuration.map((field) => field.key)).toEqual(["subscriptionAccess", "messagePreviews", "account", "cachePath"])
  for (const values of [{}, { selectionToken: "legacy" }, { ...configuration, cachePath: "relative" }, { ...configuration, account: "ambiguous-name" }]) {
    expect((yield* client.Configure({ values }))._tag).toBe("Rejected")
  }
  expect((yield* client.Describe({ parameters: { selection: "chat-id" } }))._tag).toBe("Invalid")
  expect((yield* client.Configure({ values: configuration }))._tag).toBe("Accepted")
  for (const selection of ["selected", scope]) {
    expect((yield* client.Describe({ parameters: { selection } }))._tag).toBe("Invalid")
  }
  expect(requests).toEqual([])
  for (const selection of ["first-chat", "second-chat"]) {
    expect(yield* client.Describe({ parameters: { selection } })).toMatchObject({
      _tag: "Described", subject: `teams:${scope}`, label: "Project room", parameters: { selection: pin }
    })
  }
  expect(requests).toEqual([{ selection: "first-chat" }, { selection: "second-chat" }])
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))

it.effect("real Python ledger: silent baseline, durable resume, stable replay keys and distinct repeated transitions", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  expect(baseline.events).toEqual([])
  expect(baseline.cursor.length).toBeLessThan(512)
  const changed = { scope, includeMessagePreview: false, messages: [{ ...message, body: token(5), reaction: token(6), reactions: [token(7)] }] }
  const first = yield* reconcile(scope, baseline.cursor, changed)
  expect(first.events.map((e) => e.type)).toEqual(["message.edited", "reaction.added"])
  expect(yield* reconcile(scope, baseline.cursor, changed)).toEqual(first)
  expect((yield* reconcile(scope, first.cursor, changed)).events).toEqual([])
  const reverted = yield* reconcile(scope, first.cursor, snapshot)
  const repeated = yield* reconcile(scope, reverted.cursor, changed)
  expect(repeated.events[0]?.dedupeKey).not.toEqual(first.events[0]?.dedupeKey)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: missing candidates and unknown reactions never imply deletion or removal", () => Effect.gen(function*() {
  const other = { ...message, id: token(10) }
  const baseline = yield* reconcile(scope, undefined, { scope, includeMessagePreview: false, messages: [message, other] })
  const missing = yield* reconcile(scope, baseline.cursor, { scope, includeMessagePreview: false, messages: [{ ...other, reaction: null, reactions: null }] })
  expect(missing.events).toEqual([])
  const returned = yield* reconcile(scope, missing.cursor, { scope, includeMessagePreview: false, messages: [message, other] })
  expect(returned.events).toEqual([])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: fails closed on subject mismatch, bad resume, duplicate identities", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  for (const input of [{ ...snapshot, scope: token(99) },
    { scope, includeMessagePreview: false, messages: [message, message] }, { scope, includeMessagePreview: false, messages: [{ ...message, body: "private-content" }] }]) {
    const error = yield* reconcile(scope, baseline.cursor, input).pipe(Effect.flip)
    expect(error._tag).toBe("ObservationGap")
    expect(JSON.stringify(error)).not.toContain("private-content")
  }
  expect((yield* reconcile(scope, "broken-private-cursor", snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
  expect((yield* reconcile(token(99), baseline.cursor, snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: SDK names an opaque subject, starts silently, resumes a batch and filters with its cursor", () => Effect.gen(function*() {
  let current = snapshot
  const client = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.sync(() => current) }))
  expect((yield* client.Handshake()).catalogue.eventTypes.map((e) => e.type)).toEqual([
    "message.new", "message.reply", "message.edited", "reaction.added", "reaction.removed"
  ])
  expect((yield* client.Configure({ values: configuration }))._tag).toBe("Accepted")
  expect(yield* client.Describe({ parameters: { selection: "chat-id" } })).toMatchObject({
    _tag: "Described", subject: `teams:${scope}`, parameters: { selection: pin }
  })
  const baseline = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [] }).pipe(Stream.take(1), Stream.runCollect)
  expect(baseline[0]?._tag).toBe("Cursor")
  if (baseline[0]?._tag !== "Cursor") throw new Error("Expected baseline cursor")
  const cursor = baseline[0].cursor
  current = { scope, includeMessagePreview: false, messages: [{ ...message, body: token(5), reaction: token(6), reactions: [token(7)] }] }
  const batch = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [], cursor }).pipe(Stream.take(2), Stream.runCollect)
  expect(batch.map((i) => i._tag)).toEqual(["Event", "Event"])
  expect(batch[0]).not.toHaveProperty("cursor")
  expect(batch[1]).toHaveProperty("cursor")
  const partial = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [], cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(partial).toEqual(batch.slice(0, 1))
  current = { scope, includeMessagePreview: false, messages: [{ ...message, body: token(99), reaction: token(6), reactions: [] }] }
  yield* TestClock.adjust("1 minute")
  const restarted = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.sync(() => current) }))
  yield* restarted.Configure({ values: configuration })
  const replay = yield* restarted.Watch({ parameters: { selection: pin }, eventTypes: [], cursor }).pipe(Stream.take(2), Stream.runCollect)
  expect(replay).toEqual(batch)
  const filtered = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [Ids.EventType.make("message.new")], cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(filtered[0]?._tag).toBe("Cursor")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger: SDK sanitizes acquisition failure and rejects a changed private selection", () => Effect.gen(function*() {
  let current = snapshot
  let failing = false
  const client = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.suspend(() => failing ? Effect.fail(gap()) : Effect.succeed(current)) }))
  yield* client.Configure({ values: configuration })
  current = { ...snapshot, scope: token(20) }
  const error = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip)
  expect(error._tag).toBe("SourceFailed")
  failing = true
  current = snapshot
  expect((yield* client.Watch({ parameters: { selection: pin }, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip))._tag).toBe("SourceFailed")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))

it.effect("real Python ledger: polls after the wake delay and cancels with the SDK stream", () => Effect.gen(function*() {
  let reads = 0
  const client = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.sync(() => {
    reads++
    return reads === 1 ? snapshot : { scope, includeMessagePreview: false, messages: [message, { ...message, id: token(30), parent: message.id }] }
  }) }))
  yield* client.Configure({ values: configuration })
  const ready = yield* Deferred.make<void>()
  const fiber = yield* client.Watch({ parameters: { selection: pin }, eventTypes: [] }).pipe(
    Stream.tap((item) => item._tag === "Cursor" ? Deferred.succeed(ready, undefined) : Effect.void),
    Stream.take(2), Stream.runCollect, Effect.forkChild
  )
  yield* Deferred.await(ready)
  yield* TestClock.adjust("5 seconds")
  const items = yield* Fiber.join(fiber)
  expect(items.map((i) => i._tag)).toEqual(["Cursor", "Event"])
  expect(items[1]?._tag === "Event" && items[1].event.type).toBe("message.reply")
  const stopped = reads
  yield* TestClock.adjust("1 minute")
  expect(reads).toBe(stopped)
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger: process failures and oversized output remain sanitized observation gaps", () => Effect.gen(function*() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "teams-diagnostic-test-")))
  vi.stubEnv("EXANGELOS_HOME", home)
  try {
    for (const [code, text] of [[1, "synthetic private diagnostic"], [0, "x".repeat(5_000_001)]] as const) {
      const output = Stream.make(new TextEncoder().encode(text))
      const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
        Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
          stdout: output, stderr: Stream.empty, all: output, getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
        }))))
      const error = yield* localSource.read({ scope, includeMessagePreview: false }).pipe(Effect.provide(layer), Effect.flip)
      expect(["ObservationGap", "SourceUnavailable"]).toContain(error._tag)
      expect(JSON.stringify(error)).not.toContain(text)
    }
    const path = join(home, "diagnostics/teams/last-error.json")
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ operation: "configured-snapshot", stage: "output-limit" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}).pipe(Effect.provide(ledgerProcess)))

it.effect("real Python ledger: new roots and replies have distinct event types", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  const next = yield* reconcile(scope, baseline.cursor, { scope, includeMessagePreview: false, messages: [message,
    { ...message, id: token(20) }, { ...message, id: token(21), parent: message.id }] })
  expect(next.events.map((event) => event.type)).toEqual(["message.new", "message.reply"])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: membership order and aggregate fingerprint changes do not emit reactions", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, { scope, includeMessagePreview: false,
    messages: [{ ...message, reactions: [token(8), token(7)] }] })
  const reordered = yield* reconcile(scope, baseline.cursor, { scope, includeMessagePreview: false,
    messages: [{ ...message, reaction: token(90), reactions: [token(7), token(8)] }] })
  expect(reordered.events).toEqual([])
  const changed = { scope, includeMessagePreview: false, messages: [{ ...message, reactions: [token(9)] }] }
  expect((yield* reconcile(scope, reordered.cursor, changed)).events.map((e) => e.type))
    .toEqual(["reaction.added", "reaction.removed", "reaction.removed"])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: same member add, remove and readd have distinct keys and stable replays", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  const addedSnapshot = { scope, includeMessagePreview: false, messages: [{ ...message, reactions: [token(7)] }] }
  const added = yield* reconcile(scope, baseline.cursor, addedSnapshot)
  const removed = yield* reconcile(scope, added.cursor, snapshot)
  const readded = yield* reconcile(scope, removed.cursor, addedSnapshot)
  expect([added, removed, readded].map((r) => r.events.map((e) => e.type)))
    .toEqual([["reaction.added"], ["reaction.removed"], ["reaction.added"]])
  expect(new Set([added, removed, readded].map((r) => r.events[0]?.dedupeKey)).size).toBe(3)
  expect(yield* reconcile(scope, removed.cursor, addedSnapshot)).toEqual(readded)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: unknown membership breaks continuity in both directions", () => Effect.gen(function*() {
  for (const initial of [[], [token(7)]]) {
    const baseline = yield* reconcile(scope, undefined, { scope, includeMessagePreview: false,
      messages: [{ ...message, reactions: initial }] })
    const unknown = yield* reconcile(scope, baseline.cursor, { scope, includeMessagePreview: false,
      messages: [{ ...message, reactions: null }] })
    expect(unknown.events).toEqual([])
    const restored = yield* reconcile(scope, unknown.cursor, { scope, includeMessagePreview: false,
      messages: [{ ...message, reactions: initial.length ? [] : [token(7)] }] })
    expect(restored.events).toEqual([])
    const continued = yield* reconcile(scope, restored.cursor, { scope, includeMessagePreview: false,
      messages: [{ ...message, reactions: initial }] })
    expect(continued.events.map((e) => e.type)).toEqual([initial.length ? "reaction.added" : "reaction.removed"])
  }
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: rejects duplicate memberships, malformed members and obsolete cursors", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  for (const reactions of [[token(7), token(7)], ["synthetic-invalid"], [null], Array.from({ length: 501 }, (_, i) => token(i))]) {
    const input = { scope, includeMessagePreview: false, messages: [{ ...message, reactions }] }
    expect((yield* reconcile(scope, baseline.cursor, input).pipe(Effect.flip))._tag).toBe("ObservationGap")
  }
  for (const cursor of [
    { version: 1 },
    { version: 2, scope, messages: [{ ...message, reactions: [token(7), token(7)], revision: 0 }] }
  ]) {
    expect((yield* reconcile(scope, JSON.stringify(cursor), snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
  }
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: large metadata baselines retain a bounded opaque cursor", () => Effect.gen(function*() {
  const messages = Array.from({ length: 500 }, (_, i) => ({ ...message, id: token(i + 100),
    reactions: Array.from({ length: 40 }, (_, j) => token(j + 1000)) }))
  expect((yield* reconcile(scope, undefined, { scope, includeMessagePreview: false, messages })).cursor.length).toBeLessThan(512)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("waits through restart, then replays only eligible first-snapshot replies", () => Effect.gen(function*() {
  yield* TestClock.adjust("10 seconds")
  let current: typeof Snapshot.Type = { ...snapshot, missing: "thread", messages: [] }
  let unavailable = false
  const client = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.suspend(() =>
    unavailable ? Effect.fail(new SourceUnavailable({ reason: "Could not read the fixture." })) : Effect.succeed(current)) }))
  yield* client.Configure({ values: configuration })
  const request = { parameters: { selection: pin }, eventTypes: [], acceptsPending: true, createdAt: DateTime.makeUnsafe(1000) }
  const [pending] = yield* client.Watch(request).pipe(Stream.take(1), Stream.runCollect)
  expect(pending).toMatchObject({ _tag: "Pending", reason: "Waiting for this thread to appear." })
  if (pending?._tag !== "Pending") throw new Error("Expected waiting watch")
  const resume = { ...request, cursor: pending.cursor }
  unavailable = true
  expect((yield* client.Watch(resume).pipe(Stream.runDrain, Effect.flip))._tag).toBe("SourceFailed")
  yield* TestClock.adjust("4 hours")
  unavailable = false
  expect(yield* client.Watch(resume).pipe(Stream.take(1), Stream.runCollect)).toEqual([pending])
  current = { ...snapshot, messages: [
        { ...message, id: token(7), messageTime: 999, parent: token(5) },
        { ...message, id: token(8), messageTime: 1000, parent: token(5) },
        { ...message, id: token(9), messageTime: 1001, parent: token(5) }
      ] }
  const batch = yield* client.Watch(resume).pipe(Stream.take(2), Stream.runCollect)
  expect(batch.map((item) => item._tag)).toEqual(["Event", "Event"])
  expect(yield* client.Watch(resume).pipe(Stream.take(2), Stream.runCollect)).toEqual(batch)
  const last = batch[1]
  if (last?._tag !== "Event" || !last.cursor) throw new Error("Expected committed batch")
  expect(yield* client.Watch({ ...request, cursor: last.cursor }).pipe(Stream.take(1), Stream.runCollect))
    .toEqual([{ _tag: "Cursor", cursor: last.cursor }])
  const saved = resumeWaiting(scope, pending.cursor)!
  expect(resumeWaiting(token(90), pending.cursor)).toBeUndefined()
  const nearExpiry = { ...request, cursor: waitingCursor(scope, observationBudget - 1, saved.ledger) }
  expect((yield* client.Watch(nearExpiry).pipe(Stream.take(1), Stream.runCollect))[0]?._tag).toBe("Event")
  current = { ...snapshot, missing: "thread", messages: [] }
  expect(yield* client.Watch(resume).pipe(Stream.take(2), Stream.runCollect)).toEqual(batch)
  const [fresh] = yield* client.Watch(request).pipe(Stream.take(1), Stream.runCollect)
  if (fresh?._tag !== "Pending") throw new Error("Expected new waiting watch")
  const unobserved = { ...request, cursor: waitingCursor(scope, observationBudget - 1, resumeWaiting(scope, fresh.cursor)!.ledger) }
  const firstPoll = yield* Deferred.make<void>()
  const expiry = yield* client.Watch(unobserved).pipe(
    Stream.tap((item) => item._tag === "Pending" ? Deferred.succeed(firstPoll, undefined) : Effect.void),
    Stream.runCollect, Effect.forkChild)
  yield* Deferred.await(firstPoll)
  yield* TestClock.adjust("5 seconds")
  const ended = yield* Fiber.join(expiry)
  expect(ended.map((item) => item._tag)).toEqual(["Pending", "End"])
  expect(ended[1]).toMatchObject({ reason: "Couldn't find this thread. Please check the thread ID or link." })

}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("keeps the first successful Watch cutoff when an older daemon reopens its cursor", () => Effect.gen(function*() {
  yield* TestClock.adjust("10 seconds")
  let current: typeof Snapshot.Type = { ...snapshot, missing: "thread", messages: [] }
  const client = yield* ConnectorTest.makeClient(make({ resolve, read: () => Effect.sync(() => current) }))
  yield* client.Configure({ values: configuration })
  const request = { parameters: { selection: pin }, eventTypes: [] }
  const [saved] = yield* client.Watch(request).pipe(Stream.take(1), Stream.runCollect)
  if (saved?._tag !== "Cursor") throw new Error("Expected an older daemon to receive the waiting cursor")
  yield* TestClock.adjust("1 minute")
  current = { ...snapshot, messages: [
    { ...message, id: token(7), messageTime: 9999, parent: token(5) },
    { ...message, id: token(8), messageTime: 10000, parent: token(5) }
  ] }
  const [arrival] = yield* client.Watch({ ...request, cursor: saved.cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(arrival).toMatchObject({ _tag: "Event", event: { payload: { messageTime: 10000 } } })
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)
