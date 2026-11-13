import { Effect, Record, Schema } from "effect"
import { type CommandHarness, Session, type Settings } from "@exangelos/domain"
import { SettingsStore } from "../ports/SettingsStore.ts"

export class HumanRequired extends Schema.TaggedError<HumanRequired>()("HumanRequired", {
  harness: Schema.String
}) {}

export class UnknownHarness extends Schema.TaggedError<UnknownHarness>()("UnknownHarness", {
  harness: Schema.String
}) {}

export const setHarness = (actor: Session.Actor, name: Session.HarnessName, definition: CommandHarness.Definition) =>
  Effect.gen(function*() {
    if (actor._tag !== "You") return yield* new HumanRequired({ harness: name })
    return yield* (yield* SettingsStore).update((current) =>
      Effect.succeed({ ...current, harnesses: { ...current.harnesses, [name]: definition } })
    )
  })

export const removeHarness = (actor: Session.Actor, name: Session.HarnessName) =>
  Effect.gen(function*() {
    if (actor._tag !== "You") return yield* new HumanRequired({ harness: name })
    return yield* (yield* SettingsStore).update((current) =>
      Record.has(current.harnesses, name)
        ? Effect.succeed({ ...current, harnesses: Record.remove(current.harnesses, name) })
        : Effect.fail(new UnknownHarness({ harness: name }))
    )
  })

export const requireKnown = (target: Session.Target | undefined) =>
  Effect.gen(function*() {
    if (target === undefined || Session.isBuiltInTarget(target)) return
    const settings: Settings.Settings = yield* Effect.orDie((yield* SettingsStore).read)
    if (!Record.has(settings.harnesses, target.harness)) return yield* new UnknownHarness({ harness: target.harness })
  })

