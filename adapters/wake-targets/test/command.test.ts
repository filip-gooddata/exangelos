import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, FileSystem, Layer } from "effect"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { WakeTarget } from "@exangelos/application"
import { WakeText } from "@exangelos/contracts"
import { Command, layerCommand } from "../src/index.ts"
import { content } from "./fixtures.ts"

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer)
const spawner = BunChildProcessSpawner.layer.pipe(Layer.provide(platform))
const session = { harness: "codex", sessionId: "-x:1" } as const

const deliver = (command: Command.WakeCommand, limit: Duration.Input = "5 seconds") =>
  Effect.gen(function*() {
        const target = yield* WakeTarget.WakeTarget
        yield* target.deliver(session, content)
      }).pipe(
    Effect.provide(layerCommand(command, { limit }).pipe(Layer.provide(spawner))),
    Effect.exit
  )

describe("command wake target", () => {
  it.live("hands the text on stdin and the session in the environment", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const out = `${yield* fs.makeTempDirectoryScoped()}/wake`
      const exit = yield* deliver([
        "sh",
        "-c",
        "printf '%s %s %s' \"$EXANGELOS_HARNESS\" \"$EXANGELOS_SESSION_ID\" \"$EXANGELOS_SUBSCRIPTION\" > \"$1.env\"; cat > \"$1\"",
        "sh",
        out
      ])
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* fs.readFileString(out)).toBe(WakeText.render(content))
      expect(yield* fs.readFileString(`${out}.env`)).toBe("codex -x:1 sub_7f3k")
    }).pipe(Effect.provide(platform)))

  it.live("fails with the command's last word when it exits non-zero", () =>
    Effect.gen(function*() {
      const exit = yield* deliver(["sh", "-c", "cat > /dev/null; echo 'no such session' >&2; exit 3"])
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "sh exited with 3: no such session" })))
    }))

  it.live("fails when the command hangs past the limit", () =>
    Effect.gen(function*() {
      const started = Date.now()
      const exit = yield* deliver(["sleep", "30"], "300 millis")
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "sleep did not finish within 300ms" })))
      expect(Date.now() - started).toBeLessThan(5000)
    }))
})
