import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer } from "effect"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { WakeTarget } from "@exangelos/application"
import { layerSettingsStore } from "@exangelos/application/testing"
import { WakeText } from "@exangelos/contracts"
import { type Session, Settings, type Wake } from "@exangelos/domain"
import { layer } from "../src/index.ts"
import { content, recordingSpawner } from "./fixtures.ts"

const relay = ["/opt/relay", "--session", "{session}", "--subscription={subscription}"]
const settings: Settings.Settings = { ...Settings.initial, harnesses: { relay: { command: relay } } }

const deliverTo = (
  target: Session.Target,
  options: { readonly exitCode?: number; readonly content?: Wake.WakeContent; readonly settings?: Settings.Settings } = {}
) =>
  Effect.gen(function*() {
    const runner = yield* recordingSpawner({ exitCode: options.exitCode ?? 0 })
    const exit = yield* Effect.exit(
      Effect.gen(function*() {
        yield* (yield* WakeTarget.WakeTarget).deliver(target, options.content ?? content)
      }).pipe(Effect.provide(layer().pipe(Layer.provide([runner.layer, layerSettingsStore(options.settings ?? settings)]))))
    )
    return { exit, spawned: yield* runner.spawned }
  })

describe("a harness you define", () => {
  it.effect("keeps the program and the argument count whatever the session id or wake text hold", () =>
    Effect.gen(function*() {
      const hostile = { ...content, subject: "x\"; rm -rf ~ $(touch /tmp/owned) 'y' `z`" }
      for (const sessionId of ["; rm -rf ~", "$(touch /tmp/owned)", "a \"b\" 'c' d", "$& {subscription}"]) {
        const { exit, spawned } = yield* deliverTo({ harness: "relay", sessionId }, { content: hostile })
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(spawned).toEqual([{
          program: "/opt/relay",
          args: ["--session", sessionId, "--subscription=sub_7f3k"],
          stdin: WakeText.render(hostile)
        }])
      }
    }))

  it.effect("fails the wake when the command exits non-zero", () =>
    Effect.gen(function*() {
      const { exit } = yield* deliverTo({ harness: "relay", sessionId: "s1" }, { exitCode: 3 })
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "/opt/relay exited with 3" })))
    }))

  it.effect("fails the wake when you removed the harness", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "relay", sessionId: "s1" }, { settings: Settings.initial })
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "no harness named \"relay\" in the settings" })))
      expect(spawned).toEqual([])
    }))

  it.live("fails the wake when the command runs past the limit", () =>
    Effect.gen(function*() {
      const spawner = BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)))
      const slow = { ...Settings.initial, harnesses: { slow: { command: ["sleep", "30"] } } }
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          yield* (yield* WakeTarget.WakeTarget).deliver({ harness: "slow", sessionId: "s1" }, content)
        }).pipe(Effect.provide(layer({ limit: Duration.millis(300) }).pipe(Layer.provide([spawner, layerSettingsStore(slow)]))))
      )
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "sleep did not finish within 300ms" })))
    }))
})
