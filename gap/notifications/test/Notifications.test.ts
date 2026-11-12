import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { layerLinux, layerMacOS, Notifications } from "@exangelos/notifications"
import * as FakeSpawner from "./FakeSpawner.ts"

const awkward = { title: `Say "hi" \\ end`, body: "line one\nline \"two\" ' $(rm -rf ~)" }

const show = (layer: typeof layerMacOS, fake: ReturnType<typeof FakeSpawner.make>) =>
  Notifications.use((notifications) => notifications.show(awkward)).pipe(
    Effect.provide(layer.pipe(Layer.provide(fake.layer)))
  )

describe("Notifications", () => {
  it.effect("macOS passes title and body to a fixed AppleScript as arguments", () =>
    Effect.gen(function*() {
      const fake = FakeSpawner.make()
      yield* show(layerMacOS, fake)
      expect(fake.ran).toEqual([{
        command: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          "--",
          awkward.title,
          awkward.body
        ]
      }])
    }))

  it.effect("Linux passes title and body to notify-send after the option list", () =>
    Effect.gen(function*() {
      const fake = FakeSpawner.make()
      yield* show(layerLinux, fake)
      expect(fake.ran).toEqual([{ command: "notify-send", args: ["--", awkward.title, awkward.body] }])
    }))

  it.effect("fails with the command's stderr when it exits non-zero", () =>
    Effect.gen(function*() {
      const fake = FakeSpawner.make(() => ({ exitCode: 1, stderr: "no notification server\n" }))
      const error = yield* Effect.flip(show(layerLinux, fake))
      expect(error).toMatchObject({
        _tag: "NotificationFailed",
        reason: "notify-send exited with 1: no notification server"
      })
    }))
})
