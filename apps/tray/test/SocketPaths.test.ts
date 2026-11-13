import { describe, expect, it } from "@effect/vitest"
import { Paths } from "@exangelos/paths"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import cases from "../src-tauri/tests/fixtures/socket-paths.json" with { type: "json" }

describe("socket path parity with the Rust host", () => {
  it.effect.each(cases)("resolves $socketPath for $env", ({ env, socketPath }) =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.map(Paths.Paths, (paths) => paths.socketPath).pipe(
          Effect.provide(Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))
        )
      )
      if (socketPath === null) expect(Exit.isFailure(exit)).toBe(true)
      else expect(exit).toStrictEqual(Exit.succeed(socketPath))
    }))
})
